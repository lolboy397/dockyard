package api

import (
	"net/http"
	"os"
	"regexp"
	"strings"

	"docker-manager/backend/api/handlers"
	dockerpkg "docker-manager/backend/docker"
	"docker-manager/backend/storage"
	"docker-manager/backend/watcher"

	"github.com/docker/docker/client"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

// tokenQueryRe matches a token query parameter value in a request URI.
var tokenQueryRe = regexp.MustCompile(`token=[^&]*`)

// redactTokenInLogs rewrites RequestURI so the WebSocket ?token=<session> value
// is not written to the request log by middleware.Logger. r.URL (which handlers
// read the real token from) is left untouched. Must be registered before Logger.
func redactTokenInLogs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.RequestURI, "token=") {
			r.RequestURI = tokenQueryRe.ReplaceAllString(r.RequestURI, "token=REDACTED")
		}
		next.ServeHTTP(w, r)
	})
}

const (
	// jsonBodyLimit caps control-plane request bodies (everything except the
	// project archive upload). Compose/JSON payloads are at most a few KB.
	jsonBodyLimit = 4 << 20 // 4 MiB
	// uploadBodyLimit caps the project archive upload (POST /api/v1/projects).
	uploadBodyLimit = 512 << 20 // 512 MiB
)

// limitBodySize bounds request bodies so an oversized payload cannot exhaust
// backend memory, removing the reliance on the reverse proxy for this. GET/HEAD
// have no meaningful body; the multipart project upload gets a larger cap.
func limitBodySize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Method != http.MethodGet && r.Method != http.MethodHead {
			limit := int64(jsonBodyLimit)
			if r.Method == http.MethodPost && r.URL.Path == "/api/v1/projects" {
				limit = uploadBodyLimit
			}
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		next.ServeHTTP(w, r)
	})
}

// NewRouter builds and returns the fully wired HTTP router.
func NewRouter(cli *client.Client, db *storage.DB, w *watcher.Watcher, ka *dockerpkg.KeepAlive, bk *handlers.BackupService) http.Handler {
	r := chi.NewRouter()

	r.Use(redactTokenInLogs) // must precede Logger so the token is redacted before logging
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ka.Touch()
			next.ServeHTTP(w, r)
		})
	})
	// CORS origins are scoped via CORS_ALLOWED_ORIGINS (comma-separated); default
	// "*" is safe here because auth is bearer-token (no ambient cookies).
	allowedOrigins := []string{"*"}
	if v := strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS")); v != "" {
		allowedOrigins = strings.Split(v, ",")
		for i := range allowedOrigins {
			allowedOrigins[i] = strings.TrimSpace(allowedOrigins[i])
		}
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	containers := handlers.NewContainerHandlers(cli)
	images := handlers.NewImageHandlers(cli)
	networks := handlers.NewNetworkHandlers(cli)
	volumes := handlers.NewVolumeHandlers(cli, db, bk)
	system := handlers.NewSystemHandlers(cli, db)
	stacks := handlers.NewStackHandlers(cli, db)
	events := handlers.NewEventHandlers(db)
	watcherH := handlers.NewWatcherHandlers(db, w)
	wsH := handlers.NewWSHandlers(cli)
	builds := handlers.NewBuildHandlers(db)
	registry := handlers.NewRegistryHandlers(db)
	git := handlers.NewGitHandlers(db)
	projects := handlers.NewProjectHandlers(db, cli)
	auth := handlers.NewAuthHandlers(db, cli)
	roles := handlers.NewRoleHandlers(db)
	alerts := handlers.NewAlertHandlers(db)
	appBackups := handlers.NewAppBackupHandlers(bk, db)
	updates := handlers.NewUpdateHandlers(cli, db, bk)

	r.Route("/api/v1", func(r chi.Router) {
		// Bound request bodies before handlers read them (memory-exhaustion guard).
		r.Use(limitBodySize)
		// Require a valid session for every endpoint except the public bootstrap
		// routes whitelisted in publicPaths (status / setup / login / test-connection).
		r.Use(auth.RequireAuth)
		// Enforce role-based access (viewers read-only, /users admin-only) and
		// record mutating actions against the acting user (attributed audit log).
		r.Use(auth.Authorize)
		r.Use(auth.AuditMutations)

		// Auth & first-run setup
		r.Get("/auth/status", auth.Status)
		r.Post("/auth/setup", auth.Setup)
		r.Post("/auth/login", auth.Login)
		r.Get("/auth/me", auth.Me)
		r.Post("/auth/logout", auth.Logout)
		r.Post("/auth/test-connection", auth.TestConnection)

		// Two-factor (TOTP) self-service — any authenticated user manages their own.
		r.Get("/auth/2fa", auth.TwoFactorStatus)
		r.Post("/auth/2fa/setup", auth.TwoFactorSetup)
		r.Post("/auth/2fa/confirm", auth.TwoFactorConfirm)
		r.Post("/auth/2fa/disable", auth.TwoFactorDisable)

		// User management (admin only — enforced by Authorize)
		r.Get("/users", auth.ListUsers)
		r.Post("/users", auth.CreateUser)
		r.Patch("/users/{id}", auth.UpdateUser)
		r.Delete("/users/{id}", auth.DeleteUser)
		r.Get("/users/{id}/activity", auth.UserActivity)
		r.Get("/users/{id}/sessions", auth.UserSessions)
		r.Delete("/users/{id}/sessions", auth.RevokeUserSessions)

		// Roles (read open to authed users; mutations admin-only via Authorize).
		// Static /roles/capabilities is registered before the /{id} param route.
		r.Get("/roles", roles.List)
		r.Get("/roles/capabilities", roles.Capabilities)
		r.Post("/roles", roles.Create)
		r.Get("/roles/{id}", roles.Get)
		r.Delete("/roles/{id}", roles.Delete)

		// System
		r.Get("/system/info", system.Info)
		r.Get("/system/version", system.Version)
		r.Get("/system/df", system.DiskUsage)
		r.Get("/system/docker-disk", system.DockerDisk)
		r.Get("/system/host-stats", system.HostStats)
		r.Get("/system/metrics-history", system.MetricsHistory)

		// Native self-update (admin-only, enforced in the handlers).
		r.Get("/system/update/check", updates.Check)
		r.Get("/system/update/logs", updates.Logs)
		r.Post("/system/update/apply", updates.Apply)
		r.Get("/system/changelog", updates.Changelog)

		// Application (system) backup — admin-only, enforced in the handlers.
		// Static routes registered before the parameterised {name} routes.
		r.Get("/system/backups/overview", appBackups.Overview)
		r.Get("/system/backups", appBackups.List)
		r.Post("/system/backups", appBackups.Create)
		r.Get("/system/backup-schedule", appBackups.GetSchedule)
		r.Put("/system/backup-schedule", appBackups.SetSchedule)
		r.Get("/system/backups/{name}/download", appBackups.Download)
		r.Delete("/system/backups/{name}", appBackups.Delete)

		// Containers
		r.Get("/containers", containers.List)
		r.Get("/containers/{id}", containers.Inspect)
		r.Post("/containers/{id}/start", containers.Start)
		r.Post("/containers/{id}/stop", containers.Stop)
		r.Post("/containers/{id}/restart", containers.Restart)
		r.Post("/containers/{id}/pause", containers.Pause)
		r.Post("/containers/{id}/unpause", containers.Unpause)
		r.Delete("/containers/{id}", containers.Remove)
		r.Post("/containers/{id}/rename", containers.Rename)
		r.Post("/containers/{id}/update", containers.UpdateResources)
		r.Get("/containers/{id}/logs", containers.Logs)
		r.Get("/containers/{id}/stats", containers.Stats)
		r.Get("/containers/{id}/top", containers.Top)
		r.Post("/containers/{id}/exec", containers.Exec)
		r.Delete("/containers", containers.Prune)

		// Images
		r.Get("/images", images.List)
		r.Get("/images/search", images.Search)
		r.Post("/images/pull", images.Pull)
		r.Delete("/images/prune", images.Prune)
		r.Get("/images/{id}", images.Inspect)
		r.Delete("/images/{id}", images.Remove)
		r.Post("/images/{id}/tag", images.Tag)
		r.Get("/images/{id}/history", images.History)

		// Networks
		r.Get("/networks", networks.List)
		r.Post("/networks", networks.Create)
		r.Delete("/networks/prune", networks.Prune)
		r.Get("/networks/{id}", networks.Inspect)
		r.Delete("/networks/{id}", networks.Remove)
		r.Post("/networks/{id}/connect", networks.Connect)
		r.Post("/networks/{id}/disconnect", networks.Disconnect)

		// Volumes
		r.Get("/volumes", volumes.List)
		r.Post("/volumes", volumes.Create)
		r.Delete("/volumes/prune", volumes.Prune)
		// File browser (static sub-paths registered before the {name} param route).
		r.Get("/volumes/{name}/files", volumes.Files)
		r.Get("/volumes/{name}/file", volumes.File)
		r.Get("/volumes/{name}/search", volumes.Search)
		r.Get("/volumes/{name}/usage", volumes.Usage)
		r.Get("/volumes/{name}/download", volumes.Download)
		// Volume backup / restore (versioned archives)
		r.Get("/volumes/{name}/backups", volumes.ListBackups)
		r.Post("/volumes/{name}/backups", volumes.CreateBackup)
		r.Get("/volumes/{name}/backups/{id}/download", volumes.DownloadBackup)
		r.Post("/volumes/{name}/backups/{id}/restore", volumes.RestoreBackup)
		r.Delete("/volumes/{name}/backups/{id}", volumes.DeleteBackup)
		// Opt-in automatic-backup schedule
		r.Get("/volumes/{name}/backup-schedule", volumes.GetBackupSchedule)
		r.Put("/volumes/{name}/backup-schedule", volumes.SetBackupSchedule)
		r.Delete("/volumes/{name}/backup-schedule", volumes.DeleteSchedule)
		r.Get("/volumes/{name}", volumes.Inspect)
		r.Delete("/volumes/{name}", volumes.Remove)

		// Events / audit log
		r.Get("/events", events.GetEvents)
		// Global event mute rules (read open to authed users; mutations admin-only).
		r.Get("/events/filters", events.ListFilters)
		r.Post("/events/filters", events.CreateFilter)
		r.Patch("/events/filters/{id}", events.UpdateFilter)
		r.Delete("/events/filters/{id}", events.DeleteFilter)

		// Alert rules
		r.Get("/alerts", alerts.List)
		r.Post("/alerts", alerts.Create)
		r.Put("/alerts/{id}", alerts.Update)
		r.Delete("/alerts/{id}", alerts.Delete)

		// Image watcher
		r.Get("/watcher", watcherH.List)
		r.Post("/watcher", watcherH.Upsert)
		r.Delete("/watcher", watcherH.Delete)
		r.Post("/watcher/check", watcherH.CheckNow)
		r.Post("/watcher/update", watcherH.UpdateOne)

		// Stacks (docker compose)
		r.Get("/stacks", stacks.List)
		r.Post("/stacks", stacks.Deploy)
		r.Get("/stacks/{name}", stacks.Get)
		r.Put("/stacks/{name}", stacks.Update)
		r.Delete("/stacks/{name}", stacks.Remove)
		r.Post("/stacks/{name}/{action}", stacks.Action)
		r.Get("/stacks/{name}/logs", stacks.Logs)
		r.Get("/stacks/{name}/env", stacks.GetEnv)
		r.Put("/stacks/{name}/env", stacks.SetEnv)
		r.Get("/stacks/{name}/history", stacks.History)
		r.Post("/stacks/{name}/rollback/{deployId}", stacks.Rollback)
		r.Get("/stacks/{name}/webhook", stacks.GetWebhook)

		// Builds — static routes MUST come before parameterised {id} routes
		r.Get("/builds", builds.List)
		r.Post("/builds", builds.Submit)
		r.Post("/builds/cache/clear", builds.ClearCache)
		// Build definitions
		r.Get("/builds/definitions", builds.ListDefinitions)
		r.Post("/builds/definitions", builds.CreateDefinition)
		r.Get("/builds/definitions/{id}", builds.GetDefinition)
		r.Put("/builds/definitions/{id}", builds.UpdateDefinition)
		r.Delete("/builds/definitions/{id}", builds.DeleteDefinition)
		r.Post("/builds/definitions/{id}/run", builds.RunDefinition)
		r.Get("/builds/definitions/{id}/runs", builds.ListDefinitionRuns)
		// Individual build runs
		r.Get("/builds/{id}", builds.Get)
		r.Post("/builds/{id}/cancel", builds.Cancel)

		// Registries
		r.Get("/registries", registry.List)
		r.Post("/registries", registry.Add)
		r.Delete("/registries/{id}", registry.Remove)
		r.Get("/registries/internal/images", registry.Images)

		// Git source control
		r.Get("/git/repos", git.List)
		r.Get("/git/repos/{id}", git.Get)
		r.Patch("/git/repos/{id}", git.Update)
		r.Post("/git/repos", git.Add)
		r.Delete("/git/repos/{id}", git.Remove)
		r.Get("/git/repos/{id}/status", git.Status)
		r.Post("/git/repos/{id}/stage", git.Stage)
		r.Post("/git/repos/{id}/unstage", git.Unstage)
		r.Post("/git/repos/{id}/commit", git.Commit)
		r.Post("/git/repos/{id}/push", git.Push)
		r.Post("/git/repos/{id}/pull", git.Pull)
		r.Get("/git/repos/{id}/branches", git.Branches)
		r.Post("/git/repos/{id}/checkout", git.Checkout)
		r.Get("/git/repos/{id}/log", git.Log)
		r.Get("/git/repos/{id}/diff", git.Diff)
		r.Post("/git/repos/{id}/fetch", git.Fetch)

		// Local project hosting
		r.Post("/projects", projects.Upload)
		r.Get("/projects", projects.List)
		r.Get("/projects/{id}", projects.Get)
		r.Delete("/projects/{id}", projects.Delete)
		r.Post("/projects/{id}/build", projects.Build)
		r.Post("/projects/{id}/run", projects.Run)
		r.Post("/projects/{id}/restart", projects.Restart)
		r.Post("/projects/{id}/stop", projects.Stop)
		r.Get("/projects/{id}/logs", projects.Logs)
		r.Get("/projects/{id}/files", projects.Files)
		r.Get("/projects/{id}/file", projects.FileContent)
		r.Patch("/projects/{id}/ports", projects.UpdatePorts)
		r.Get("/projects/{id}/port-check", projects.CheckPorts)
		r.Patch("/projects/{id}/port-override", projects.PortOverride)
		r.Post("/projects/{id}/repo/init", projects.InitRepo)
		r.Get("/projects/{id}/deploy-hook", projects.GetDeployHook)
		r.Post("/projects/{id}/deploy-hook", projects.EnableDeployHook)
		r.Delete("/projects/{id}/deploy-hook", projects.DisableDeployHook)
	})

	// Hosted Git smart HTTP endpoint for managed repositories.
	r.Handle("/git/{name}/*", http.HandlerFunc(git.HTTPGit))

	// WebSocket endpoints (no /api/v1 prefix to keep URLs clean). These require a
	// valid session token, supplied as a ?token= query parameter since browsers
	// cannot set Authorization headers on WebSocket connections.
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireAuth)
		r.Get("/ws/logs", wsH.StreamLogs)
		r.Get("/ws/logs/multi", wsH.StreamMultiLogs)
		r.Get("/ws/stats", wsH.StreamStats)
		r.Get("/ws/events", wsH.StreamEvents)
		r.Get("/ws/exec", wsH.StreamExec)
		r.Get("/ws/allstats", wsH.StreamAllStats)
		r.Get("/ws/projects/{id}/build-logs", projects.StreamBuildLogs)
		r.Get("/ws/projects/{id}/delete-progress", projects.StreamDeleteProgress)
	})

	// Public CI deploy webhook — token-authenticated, redeploys the stack's
	// latest compose snapshot.
	r.Post("/webhooks/stack/{name}", stacks.TriggerWebhook)
	r.Post("/webhooks/project/{id}", projects.TriggerDeploy)

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck
	})

	return r
}
