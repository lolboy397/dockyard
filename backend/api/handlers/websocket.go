package handlers

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"docker-manager/backend/safe"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin:     checkSameOrigin,
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
}

// checkSameOrigin permits a WebSocket upgrade only when the request's Origin
// matches its Host (or when there is no Origin header, as with non-browser
// clients). This blocks cross-site WebSocket hijacking from other web origins.
func checkSameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

type WSHandlers struct {
	docker *client.Client
	stats  *statsHub
}

func NewWSHandlers(cli *client.Client) *WSHandlers {
	return &WSHandlers{docker: cli, stats: newStatsHub(cli)}
}

// StreamLogs upgrades to WebSocket and streams container logs in real time.
func (h *WSHandlers) StreamLogs(w http.ResponseWriter, r *http.Request) {
	// Logs may leak secrets, so the /ws group's RequireAuth isn't enough — gate
	// log content to operator+ before upgrading (see canViewLogs).
	if !canViewLogs(r) {
		writeError(w, http.StatusForbidden, errMsg("operator role required"))
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, errMsg("id is required"))
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Cancel context when client disconnects.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "50"
	}

	rc, err := h.docker.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Tail:       tail,
		Timestamps: true,
	})
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("error: %s", err))) //nolint:errcheck
		return
	}
	defer rc.Close()

	// Docker log streams use an 8-byte multiplexing header per frame.
	// stdcopy.StdCopy strips those headers so we only write valid UTF-8 text.
	pr, pw := io.Pipe()

	go func() {
		_, copyErr := stdcopy.StdCopy(pw, pw, rc)
		pw.CloseWithError(copyErr)
	}()

	buf := make([]byte, 4096)
	for {
		n, err := pr.Read(buf)
		if n > 0 {
			if writeErr := conn.WriteMessage(websocket.TextMessage, buf[:n]); writeErr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// logFrame is one multiplexed frame tagged with its source container. Type is
// "log" for normal output, "error" for a stream/subscription failure, and
// "status" for connection notices (e.g. dropped lines); the client renders each
// differently. TS is Docker's RFC3339Nano timestamp parsed off the line (empty
// when the line carried none), so the client can show the real log time instead
// of its own receive time.
type logFrame struct {
	Type   string     `json:"type,omitempty"`
	ID     string     `json:"id,omitempty"`
	TS     string     `json:"ts,omitempty"`
	Data   string     `json:"data"`
	Counts *logCounts `json:"counts,omitempty"`
}

// logCounts is a periodic per-container tally of lines by level. It's sent so the
// level pills stay accurate even when server-side level filtering means the
// client no longer receives every line. Counts are cumulative for the follow.
type logCounts struct {
	Info int `json:"info"`
	Warn int `json:"warn"`
	Err  int `json:"err"`
}

// logSub tracks one container's follow goroutine. The generation lets a follower
// that exits on its own (container stopped / stream ended) clean up only its own
// slot, so a later re-subscribe of the same container isn't clobbered.
type logSub struct {
	cancel context.CancelFunc
	gen    int64
}

// maxMultiLogSubs caps how many containers a single multiplexed connection may
// follow, bounding the Docker log streams one client can open.
const maxMultiLogSubs = 200

// Level classification mirrors the client heuristic. Warn is checked before err
// so a line mentioning both reads as a warning (matches the frontend).
var (
	logWarnRe = regexp.MustCompile(`(?i)\b(WARN|WARNING)\b`)
	logErrRe  = regexp.MustCompile(`(?i)\b(ERROR|ERR|FATAL|CRIT|PANIC|EMERG|ALERT)\b`)
	// Structured (JSON) lines: pull the declared level field instead of guessing
	// over the whole line (so a "panic" substring in a message can't mistag an
	// info line). Mirrors the client's parseStructured.
	jsonLevelRe = regexp.MustCompile(`(?i)"(?:level|lvl|severity|levelname|loglevel)"\s*:\s*"([^"]+)"`)
)

// jsonLevelMap normalizes common structured-log level strings to info|warn|err.
var jsonLevelMap = map[string]string{
	"trace": "info", "debug": "info", "info": "info", "information": "info", "notice": "info",
	"warn": "warn", "warning": "warn",
	"error": "err", "err": "err", "fatal": "err", "panic": "err", "dpanic": "err",
	"critical": "err", "crit": "err", "emergency": "err", "emerg": "err", "alert": "err",
}

func lineLevel(msg string) string {
	// A valid JSON object is a structured log: trust its declared level, and never
	// regex-guess over its field names (matches the client exactly).
	if t := strings.TrimSpace(msg); strings.HasPrefix(t, "{") && json.Valid([]byte(t)) {
		if m := jsonLevelRe.FindStringSubmatch(t); m != nil {
			if lvl, ok := jsonLevelMap[strings.ToLower(m[1])]; ok {
				return lvl
			}
		}
		return "info"
	}
	if logWarnRe.MatchString(msg) {
		return "warn"
	}
	if logErrRe.MatchString(msg) {
		return "err"
	}
	return "info"
}

// matchLevel reports whether a line's level passes the active filter (empty/"all"
// passes everything).
func matchLevel(filter, lvl string) bool {
	return filter == "" || filter == "all" || filter == lvl
}

// StreamMultiLogs streams logs from MANY containers over a SINGLE WebSocket,
// replacing the previous one-socket-per-container approach (e.g. 30 sockets for a
// 30-container page → 1). The client controls which containers are followed with
// JSON control messages:
//
//	{"action":"subscribe","id":"<cid>","tail":"50"}     (or "ids":[...])
//	{"action":"unsubscribe","id":"<cid>"}               (or "ids":[...])
//
// Each log line is delivered as {"id":"<cid>","data":"<line>"} so the client
// demultiplexes by id. The backend still follows each container's log stream
// (Docker has no multi-container logs API), but that is cheap server-side and
// centrally managed behind the one connection.
func (h *WSHandlers) StreamMultiLogs(w http.ResponseWriter, r *http.Request) {
	// Gate before the upgrade so a viewer gets a clean HTTP 403, not a socket that
	// silently closes (see canViewLogs — logs are operator+).
	if !canViewLogs(r) {
		writeError(w, http.StatusForbidden, errMsg("operator role required"))
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Single writer goroutine — gorilla/websocket forbids concurrent writes, so
	// every follower funnels frames through this buffered channel. Sends are
	// non-blocking: if the client can't keep up and the buffer fills, frames are
	// dropped (and counted) rather than stalling every follower behind the
	// slowest consumer — a live tail can't render thousands of lines/sec anyway.
	out := make(chan []byte, 1024)
	var dropped int64

	// Connection-level line filter, set by the client's level pills. Each follower
	// applies it so non-matching lines never cross the wire; changing it takes
	// effect immediately with no refetch (counts are still sent for every line).
	var levelFilter atomic.Value
	levelFilter.Store("")
	curLevel := func() string { s, _ := levelFilter.Load().(string); return s }

	emit := func(f logFrame) {
		if f.Type == "" {
			f.Type = "log"
		}
		b, err := json.Marshal(f)
		if err != nil {
			return
		}
		select {
		case out <- b:
		default:
			atomic.AddInt64(&dropped, 1)
		}
	}

	go func() {
		// Periodically surface how many frames were dropped so the operator knows
		// the view is incomplete rather than silently missing lines.
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-out:
				if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					cancel()
					return
				}
			case <-ticker.C:
				if d := atomic.SwapInt64(&dropped, 0); d > 0 {
					note, _ := json.Marshal(logFrame{Type: "status", Data: fmt.Sprintf("%d line(s) dropped — stream too fast to render", d)})
					if err := conn.WriteMessage(websocket.TextMessage, note); err != nil {
						cancel()
						return
					}
				}
			}
		}
	}()

	var mu sync.Mutex
	var gen int64
	subs := map[string]logSub{}

	subscribe := func(id, tail, since string) {
		if id == "" {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if _, ok := subs[id]; ok {
			return
		}
		if len(subs) >= maxMultiLogSubs {
			// Tell the client instead of silently dropping the request.
			emit(logFrame{Type: "error", ID: id, Data: fmt.Sprintf("subscription limit reached (%d): cannot follow more containers on one connection", maxMultiLogSubs)})
			return
		}
		gen++
		myGen := gen
		sctx, scancel := context.WithCancel(ctx)
		subs[id] = logSub{cancel: scancel, gen: myGen}
		go func() {
			h.followLogs(sctx, id, tail, since, curLevel, emit)
			// Follower ended (unsubscribed, container stopped, or stream closed):
			// drop our own slot so the container can be followed again later.
			mu.Lock()
			if s, ok := subs[id]; ok && s.gen == myGen {
				delete(subs, id)
			}
			mu.Unlock()
		}()
	}
	unsubscribe := func(id string) {
		mu.Lock()
		defer mu.Unlock()
		if s, ok := subs[id]; ok {
			s.cancel()
			delete(subs, id)
		}
	}

	// Control read loop; a ReadMessage error means the client went away, which
	// cancels ctx and tears down every follower.
	for {
		_, data, readErr := conn.ReadMessage()
		if readErr != nil {
			cancel()
			return
		}
		var ctrl struct {
			Action string   `json:"action"`
			ID     string   `json:"id"`
			IDs    []string `json:"ids"`
			Tail   string   `json:"tail"`
			Since  string   `json:"since"`
			Level  string   `json:"level"`
		}
		if json.Unmarshal(data, &ctrl) != nil {
			continue
		}
		switch ctrl.Action {
		case "subscribe":
			subscribe(ctrl.ID, ctrl.Tail, ctrl.Since)
			for _, id := range ctrl.IDs {
				subscribe(id, ctrl.Tail, ctrl.Since)
			}
		case "unsubscribe":
			unsubscribe(ctrl.ID)
			for _, id := range ctrl.IDs {
				unsubscribe(id)
			}
		case "level":
			levelFilter.Store(ctrl.Level)
		}
	}
}

// followLogs follows one container's logs and emits tagged, line-framed frames
// via emit until ctx is cancelled. When since is set (a reconnect resuming from
// the last line the client already has) it replays from that timestamp instead
// of the full tail, so reconnects don't dump duplicate history.
func (h *WSHandlers) followLogs(ctx context.Context, id, tail, since string, levelFn func() string, emit func(logFrame)) {
	if tail == "" {
		tail = "50"
	}
	opts := container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: true, Tail: tail, Timestamps: true,
	}
	if since != "" {
		// Time-bound the replay to what we missed; Tail still caps the count so a
		// long gap can't flood the client.
		opts.Since = since
	}
	rc, err := h.docker.ContainerLogs(ctx, id, opts)
	if err != nil {
		emit(logFrame{Type: "error", ID: id, Data: fmt.Sprintf("error: %s", err)})
		return
	}
	defer rc.Close()

	pr, pw := io.Pipe()
	go func() {
		_, copyErr := stdcopy.StdCopy(pw, pw, rc)
		pw.CloseWithError(copyErr)
	}()

	// Counts tally EVERY line by level (regardless of the emit filter) so the
	// client's pills stay accurate. A 1s ticker flushes them when dirty — even
	// while the read blocks on a quiet container — and a final flush runs on exit.
	var cmu sync.Mutex
	var counts logCounts
	dirty := false
	flush := func() {
		cmu.Lock()
		if !dirty {
			cmu.Unlock()
			return
		}
		c := counts
		dirty = false
		cmu.Unlock()
		emit(logFrame{Type: "counts", ID: id, Counts: &c})
	}
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-t.C:
				flush()
			}
		}
	}()
	defer close(done)
	defer flush()

	reader := bufio.NewReader(pr)
	for {
		line, readErr := reader.ReadString('\n')
		if line != "" {
			ts, msg := splitLogTimestamp(strings.TrimRight(line, "\r\n"))
			lvl := lineLevel(msg)
			cmu.Lock()
			switch lvl {
			case "warn":
				counts.Warn++
			case "err":
				counts.Err++
			default:
				counts.Info++
			}
			dirty = true
			cmu.Unlock()
			if matchLevel(levelFn(), lvl) {
				emit(logFrame{Type: "log", ID: id, TS: ts, Data: msg})
			}
		}
		if readErr != nil {
			return
		}
	}
}

// splitLogTimestamp separates Docker's RFC3339Nano timestamp prefix (added by
// Timestamps:true) from the rest of the line. It returns ("", line) when the
// line has no parseable timestamp prefix, so non-timestamped output passes
// through unchanged.
func splitLogTimestamp(line string) (ts, msg string) {
	sp := strings.IndexByte(line, ' ')
	if sp <= 0 {
		return "", line
	}
	if _, err := time.Parse(time.RFC3339Nano, line[:sp]); err != nil {
		return "", line
	}
	return line[:sp], line[sp+1:]
}

// StreamStats upgrades to WebSocket and streams container stats every second.
func (h *WSHandlers) StreamStats(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, errMsg("id is required"))
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	resp, err := h.docker.ContainerStats(ctx, id, true)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("error: %s", err))) //nolint:errcheck
		return
	}
	defer resp.Body.Close()

	dec := json.NewDecoder(resp.Body)
	for {
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return
		}
		if writeErr := conn.WriteMessage(websocket.TextMessage, raw); writeErr != nil {
			return
		}
	}
}

// StreamEvents upgrades to WebSocket and streams Docker daemon events.
func (h *WSHandlers) StreamEvents(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	eventsCh, errCh := h.docker.Events(ctx, events.ListOptions{})
	for {
		select {
		case event, ok := <-eventsCh:
			if !ok {
				return
			}
			data, _ := json.Marshal(event)
			if writeErr := conn.WriteMessage(websocket.TextMessage, data); writeErr != nil {
				return
			}
		case <-errCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

// Ping is a simple keepalive endpoint for WebSocket clients.
func (h *WSHandlers) Ping(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
			return
		}
	}
}

// StreamExec upgrades to WebSocket and attaches to an interactive exec session inside a container.
// Query params: id (container ID), shell (default /bin/sh)
func (h *WSHandlers) StreamExec(w http.ResponseWriter, r *http.Request) {
	// The /ws group only enforces RequireAuth, and Authorize keys off the HTTP
	// method (a WS upgrade is a GET), so exec — which pipes interactive stdin
	// into a container and is effectively host-root via the mounted socket —
	// must gate the role explicitly here. Read-only viewers are rejected; the
	// equivalent REST route (POST /containers/{id}/exec) is already operator+.
	if !canWrite(r) {
		writeError(w, http.StatusForbidden, errMsg("operator role required"))
		return
	}

	id := r.URL.Query().Get("id")
	if id == "" {
		writeError(w, http.StatusBadRequest, errMsg("id is required"))
		return
	}
	shell := r.URL.Query().Get("shell")
	if shell == "" {
		shell = "/bin/sh"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	execID, err := h.docker.ContainerExecCreate(ctx, id, container.ExecOptions{
		Cmd:          []string{shell},
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          false,
	})
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("error: %s\r\n", err))) //nolint:errcheck
		return
	}

	hr, err := h.docker.ContainerExecAttach(ctx, execID.ID, container.ExecStartOptions{})
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("error: %s\r\n", err))) //nolint:errcheck
		return
	}
	defer hr.Close()

	// Pipe container stdout+stderr → WebSocket (stripping Docker multiplex header)
	go func() {
		defer safe.Recover("ws-exec-copy")
		defer cancel()
		pr, pw := io.Pipe()
		go func() {
			stdcopy.StdCopy(pw, pw, hr.Reader) //nolint:errcheck
			pw.Close()
		}()
		buf := make([]byte, 4096)
		for {
			n, readErr := pr.Read(buf)
			if n > 0 {
				if writeErr := conn.WriteMessage(websocket.TextMessage, buf[:n]); writeErr != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	// WebSocket → container stdin
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if _, err := hr.Conn.Write(append(msg, '\n')); err != nil {
			return
		}
	}
}

// ContainerStatSummary is a lightweight stats snapshot for one container.
// NetRx/NetTx are cumulative byte counters (summed across the container's
// interfaces); the client derives throughput from the delta between samples.
type ContainerStatSummary struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	CPU      float64 `json:"cpu"`
	Mem      uint64  `json:"mem"`
	MemLimit uint64  `json:"mem_limit"`
	NetRx    uint64  `json:"net_rx"`
	NetTx    uint64  `json:"net_tx"`
}

// StreamAllStats upgrades to WebSocket and forwards the shared all-container stats
// snapshot (collected once for every viewer) as it is produced.
func (h *WSHandlers) StreamAllStats(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				cancel()
				return
			}
		}
	}()

	snapshots, unsubscribe := h.stats.subscribe()
	defer unsubscribe()

	for {
		select {
		case <-ctx.Done():
			return
		case snap, ok := <-snapshots:
			if !ok {
				return
			}
			data, _ := json.Marshal(snap)
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		}
	}
}

// statsContainerConcurrency caps how many ContainerStats calls run at once during a
// single collection, so a host with hundreds of containers doesn't burst that many
// simultaneous requests at the Docker socket proxy.
const statsContainerConcurrency = 24

// statsHub runs ONE all-container stats collection loop shared by every
// /ws/allstats subscriber, instead of each WebSocket polling the daemon
// independently (M users would otherwise mean M× the load). The loop runs only
// while at least one subscriber is connected.
type statsHub struct {
	docker    *client.Client
	collectFn func(context.Context) []ContainerStatSummary // overridable for tests
	mu        sync.Mutex
	subs      map[chan []ContainerStatSummary]struct{}
	cancel    context.CancelFunc
}

func newStatsHub(cli *client.Client) *statsHub {
	h := &statsHub{docker: cli, subs: map[chan []ContainerStatSummary]struct{}{}}
	h.collectFn = h.collect
	return h
}

// subscribe registers a receiver and starts the shared loop if it isn't running.
// The returned func unsubscribes and stops the loop when the last subscriber leaves.
func (s *statsHub) subscribe() (<-chan []ContainerStatSummary, func()) {
	ch := make(chan []ContainerStatSummary, 1)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	if s.cancel == nil {
		ctx, cancel := context.WithCancel(context.Background())
		s.cancel = cancel
		go s.run(ctx)
	}
	s.mu.Unlock()

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			s.mu.Lock()
			delete(s.subs, ch)
			close(ch)
			if len(s.subs) == 0 && s.cancel != nil {
				s.cancel()
				s.cancel = nil
			}
			s.mu.Unlock()
		})
	}
}

func (s *statsHub) run(ctx context.Context) {
	defer safe.Recover("ws-statshub")
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	s.broadcast(s.collectFn(ctx))
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.broadcast(s.collectFn(ctx))
		}
	}
}

// broadcast delivers a snapshot to every subscriber without blocking: each channel
// buffers only the latest snapshot, so a slow consumer just misses a tick (it gets
// the next one) and never stalls collection for the others.
func (s *statsHub) broadcast(snap []ContainerStatSummary) {
	if snap == nil {
		return
	}
	s.mu.Lock()
	for ch := range s.subs {
		select {
		case ch <- snap:
		default:
		}
	}
	s.mu.Unlock()
}

func (s *statsHub) collect(ctx context.Context) []ContainerStatSummary {
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	containers, err := s.docker.ContainerList(cctx, container.ListOptions{})
	if err != nil {
		return nil
	}
	if len(containers) == 0 {
		return []ContainerStatSummary{}
	}

	type result struct {
		s   ContainerStatSummary
		err error
	}
	ch := make(chan result, len(containers))
	sem := make(chan struct{}, statsContainerConcurrency)

	var wg sync.WaitGroup
	for i := range containers {
		c := containers[i]
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer safe.Recover("ws-allstats-worker")
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-cctx.Done():
				ch <- result{err: cctx.Err()}
				return
			}
			resp, err := s.docker.ContainerStats(cctx, c.ID, false)
			if err != nil {
				ch <- result{err: err}
				return
			}
			defer resp.Body.Close()

			var raw struct {
				CPUStats struct {
					CPUUsage struct {
						TotalUsage uint64 `json:"total_usage"`
					} `json:"cpu_usage"`
					SystemCPUUsage uint64 `json:"system_cpu_usage"`
					OnlineCPUs     int    `json:"online_cpus"`
				} `json:"cpu_stats"`
				PreCPUStats struct {
					CPUUsage struct {
						TotalUsage uint64 `json:"total_usage"`
					} `json:"cpu_usage"`
					SystemCPUUsage uint64 `json:"system_cpu_usage"`
				} `json:"precpu_stats"`
				MemoryStats struct {
					Usage uint64 `json:"usage"`
					Limit uint64 `json:"limit"`
				} `json:"memory_stats"`
				Networks map[string]struct {
					RxBytes uint64 `json:"rx_bytes"`
					TxBytes uint64 `json:"tx_bytes"`
				} `json:"networks"`
			}

			if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
				ch <- result{err: err}
				return
			}

			cpuDelta := raw.CPUStats.CPUUsage.TotalUsage - raw.PreCPUStats.CPUUsage.TotalUsage
			sysDelta := raw.CPUStats.SystemCPUUsage - raw.PreCPUStats.SystemCPUUsage
			n := raw.CPUStats.OnlineCPUs
			if n == 0 {
				n = 1
			}
			cpu := 0.0
			if sysDelta > 0 {
				cpu = float64(cpuDelta) / float64(sysDelta) * float64(n) * 100
			}

			name := c.ID[:8]
			if len(c.Names) > 0 {
				name = strings.TrimPrefix(c.Names[0], "/")
			}

			var rx, tx uint64
			for _, n := range raw.Networks {
				rx += n.RxBytes
				tx += n.TxBytes
			}

			ch <- result{s: ContainerStatSummary{
				ID:       c.ID,
				Name:     name,
				CPU:      cpu,
				Mem:      raw.MemoryStats.Usage,
				MemLimit: raw.MemoryStats.Limit,
				NetRx:    rx,
				NetTx:    tx,
			}}
		}()
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	summaries := make([]ContainerStatSummary, 0, len(containers))
	timeout := time.After(6 * time.Second)
	for {
		select {
		case r, ok := <-ch:
			if !ok {
				return summaries
			}
			if r.err == nil {
				summaries = append(summaries, r.s)
			}
		case <-timeout:
			return summaries
		case <-cctx.Done():
			return summaries
		}
	}
}
