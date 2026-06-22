package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"docker-manager/backend/api"
	"docker-manager/backend/api/handlers"
	dockerpkg "docker-manager/backend/docker"
	"docker-manager/backend/safe"
	"docker-manager/backend/storage"
	"docker-manager/backend/watcher"

	dockerevents "github.com/docker/docker/api/types/events"
	"github.com/docker/docker/client"
)

func main() {
	// Self-update helper subcommand: `docker-manager self-update [project]`. Runs
	// in a throwaway helper container to recreate the stack in place, so it must
	// not open the DB or start the server — handle it before anything else.
	if len(os.Args) > 1 && os.Args[1] == "self-update" {
		project := ""
		if len(os.Args) > 2 {
			project = os.Args[2]
		}
		runSelfUpdate(project)
		return
	}

	port := envOrDefault("PORT", "8080")
	dbPath := envOrDefault("DB_PATH", "docker-manager.db")

	// Open database.
	db, err := storage.Open(dbPath)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()
	log.Printf("database opened at %s", dbPath)

	// Connect to Docker daemon.
	cli, err := dockerpkg.NewClient()
	if err != nil {
		log.Fatalf("failed to connect to Docker: %v", err)
	}
	defer cli.Close()
	log.Println("connected to Docker daemon")

	// Start Docker socket keep-alive (lazy ping, 30-min idle expiry).
	keepAlive := dockerpkg.NewKeepAlive(cli)

	// Reset jobs left in a non-terminal state by a previous crash/restart so
	// they don't appear stuck "running"/"building" forever.
	if n, err := db.ReconcileInterruptedJobs(); err != nil {
		log.Printf("[startup] job reconciliation error: %v", err)
	} else if n > 0 {
		log.Printf("[startup] reconciled %d interrupted job(s) to 'failed'", n)
	}

	// Start image watcher. Each background worker runs under panic recovery so a
	// single panic cannot take the whole control plane down.
	w := watcher.New(db, cli)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	safe.Go("watcher", func() { w.Run(ctx) })

	// Start Docker event consumer — persists daemon events to the DB.
	safe.Go("event-consumer", func() { runDockerEventConsumer(ctx, cli, db) })

	// Periodically sweep expired sessions so the table doesn't grow unbounded.
	safe.Go("session-sweeper", func() { runSessionSweeper(ctx, db) })

	// Sample host load into the metrics time-series for historical charts.
	safe.Go("metrics-sampler", func() { runMetricsSampler(ctx, cli, db) })

	// Evaluate alert rules and fire/resolve notifications.
	safe.Go("alert-evaluator", func() { runAlertEvaluator(ctx, cli, db) })

	// Volume backup engine + opt-in automatic-backup scheduler (shared with the
	// HTTP handlers so manual and scheduled backups use the same code path).
	backups := handlers.NewBackupService(cli, db)
	safe.Go("backup-scheduler", func() { backups.RunScheduler(ctx) })

	// Build HTTP server.
	router := api.NewRouter(cli, db, w, keepAlive, backups)
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%s", port),
		Handler:      router,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 0, // 0 = no limit (log streaming can run indefinitely)
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown on SIGINT / SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("server listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-stop
	log.Println("shutting down...")
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("stopped")
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envIntOrDefault reads a positive integer env var, falling back to def.
func envIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// noiseActions are high-frequency exec/health event prefixes we skip to keep the log clean.
// Docker includes the command in exec action strings, e.g. "exec_create: wget -qO- ..."
var noiseActionPrefixes = []string{
	"exec_create", "exec_start", "exec_die", "exec_detach",
	"health_status", "top",
}

func isNoise(action string) bool {
	for _, prefix := range noiseActionPrefixes {
		if action == prefix || strings.HasPrefix(action, prefix+":") || strings.HasPrefix(action, prefix+" ") {
			return true
		}
	}
	return false
}

// runSessionSweeper periodically deletes expired sessions from the database.
func runSessionSweeper(ctx context.Context, db *storage.DB) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n, err := db.DeleteExpiredSessions(); err != nil {
				log.Printf("[sessions] sweep error: %v", err)
			} else if n > 0 {
				log.Printf("[sessions] swept %d expired sessions", n)
			}
		}
	}
}

// runMetricsSampler periodically records host load into the metrics time-series
// and prunes samples older than 7 days.
func runMetricsSampler(ctx context.Context, cli *client.Client, db *storage.DB) {
	// Events/audit retention is configurable (default 90 days) — a busy host can
	// generate a lot of daemon events, so operators may want a shorter window.
	eventRetentionSec := envIntOrDefault("EVENT_RETENTION_DAYS", 90) * 24 * 3600

	sample := func() {
		s, err := handlers.ComputeHostStats(ctx, cli)
		if err != nil {
			return
		}
		_ = db.InsertMetricSample(storage.MetricSample{
			CPUPct: s.CPUPct, MemUsed: s.MemUsed, MemTotal: s.MemTotal,
			DiskUsed: s.DiskUsed, DiskTotal: s.DiskTotal,
		})
	}
	sample()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	prune := time.NewTicker(1 * time.Hour)
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sample()
		case <-prune.C:
			_ = db.PruneMetricSamples(7 * 24 * 3600)
			// Retain events/audit history for the configured window; the table is
			// otherwise unbounded (every audited mutation + daemon event).
			if n, err := db.PruneEvents(eventRetentionSec); err != nil {
				log.Printf("[events] prune error: %v", err)
			} else if n > 0 {
				log.Printf("[events] pruned %d old event(s)", n)
			}
		}
	}
}

// runDockerEventConsumer subscribes to the Docker daemon event stream and
// persists every significant event to the database. It reconnects automatically
// when the stream drops.
func runDockerEventConsumer(ctx context.Context, cli *client.Client, db *storage.DB) {
	backoff := time.Second
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		consumeDockerEvents(ctx, cli, db)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
	}
}

func consumeDockerEvents(ctx context.Context, cli *client.Client, db *storage.DB) {
	eventsCh, errCh := cli.Events(ctx, dockerevents.ListOptions{})

	// Coalesce the event firehose into batched inserts — one transaction per flush
	// instead of one per event — which matters on a churny host. The realtime UI
	// gets events straight from the daemon stream, so a short DB-write delay only
	// affects the persisted audit log, not live updates.
	const maxBatch = 200
	buf := make([]storage.Event, 0, maxBatch)
	flush := time.NewTicker(250 * time.Millisecond)
	defer flush.Stop()
	doFlush := func() {
		if len(buf) == 0 {
			return
		}
		if err := db.LogEventsBatch(buf); err != nil {
			log.Printf("[events] batch write error: %v", err)
		}
		buf = buf[:0]
	}

	for {
		select {
		case <-ctx.Done():
			doFlush()
			return
		case err := <-errCh:
			if err != nil {
				log.Printf("[events] stream error: %v", err)
			}
			doFlush()
			return
		case <-flush.C:
			doFlush()
		case e, ok := <-eventsCh:
			if !ok {
				doFlush()
				return
			}
			if isNoise(string(e.Action)) {
				continue
			}
			// A real container lifecycle event means the cached container list is
			// stale — drop it so the refetch this event triggers sees fresh data.
			if e.Type == dockerevents.ContainerEventType {
				handlers.InvalidateContainerCache()
			}
			buf = append(buf, dockerEventRecord(e))
			if len(buf) >= maxBatch {
				doFlush()
			}
		}
	}
}

// dockerEventRecord converts a daemon event into the row to persist.
func dockerEventRecord(e dockerevents.Message) storage.Event {
	objectName := e.Actor.Attributes["name"]
	if objectName == "" {
		objectName = shortID(e.Actor.ID)
	}

	containerID := ""
	imageRef := ""
	switch e.Type {
	case dockerevents.ContainerEventType:
		containerID = e.Actor.ID
		imageRef = e.Actor.Attributes["image"]
	case dockerevents.ImageEventType:
		imageRef = e.Actor.ID
		if imageRef == "" {
			imageRef = objectName
		}
	}

	return storage.Event{
		Kind:        string(e.Action),
		Actor:       "engine",
		ObjectType:  string(e.Type),
		ObjectName:  objectName,
		ContainerID: containerID,
		Image:       imageRef,
		Message:     buildEventMessage(e),
	}
}

// buildEventMessage assembles a human-readable detail string from event attributes.
func buildEventMessage(e dockerevents.Message) string {
	var parts []string
	if code, ok := e.Actor.Attributes["exitCode"]; ok {
		parts = append(parts, "exit code "+code)
	}
	if sig, ok := e.Actor.Attributes["signal"]; ok {
		parts = append(parts, "signal "+sig)
	}
	if oomKilled, ok := e.Actor.Attributes["oomKilled"]; ok && oomKilled == "true" {
		parts = append(parts, "OOM killed")
	}
	if newName, ok := e.Actor.Attributes["newName"]; ok {
		parts = append(parts, "→ "+newName)
	}
	return strings.Join(parts, " · ")
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}
