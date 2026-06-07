package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
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
}

func NewWSHandlers(cli *client.Client) *WSHandlers {
	return &WSHandlers{docker: cli}
}

// StreamLogs upgrades to WebSocket and streams container logs in real time.
func (h *WSHandlers) StreamLogs(w http.ResponseWriter, r *http.Request) {
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
type ContainerStatSummary struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	CPU      float64 `json:"cpu"`
	Mem      uint64  `json:"mem"`
	MemLimit uint64  `json:"mem_limit"`
}

// StreamAllStats upgrades to WebSocket and sends aggregated stats for all running containers every 3 seconds.
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

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	// Send one immediately on connect
	if summaries := h.collectAllStats(ctx); summaries != nil {
		data, _ := json.Marshal(summaries)
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			return
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			summaries := h.collectAllStats(ctx)
			if summaries == nil {
				continue
			}
			data, _ := json.Marshal(summaries)
			if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		}
	}
}

func (h *WSHandlers) collectAllStats(ctx context.Context) []ContainerStatSummary {
	containers, err := h.docker.ContainerList(ctx, container.ListOptions{})
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

	var wg sync.WaitGroup
	for i := range containers {
		c := containers[i]
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer safe.Recover("ws-allstats-worker")
			resp, err := h.docker.ContainerStats(ctx, c.ID, false)
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

			ch <- result{s: ContainerStatSummary{
				ID:       c.ID,
				Name:     name,
				CPU:      cpu,
				Mem:      raw.MemoryStats.Usage,
				MemLimit: raw.MemoryStats.Limit,
			}}
		}()
	}

	go func() {
		wg.Wait()
		close(ch)
	}()

	summaries := make([]ContainerStatSummary, 0, len(containers))
	timeout := time.After(4 * time.Second)
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
		case <-ctx.Done():
			return summaries
		}
	}
}
