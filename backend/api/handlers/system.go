package handlers

import (
	"context"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"

	"docker-manager/backend/storage"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
)

type SystemHandlers struct {
	docker *client.Client
	db     *storage.DB
}

func NewSystemHandlers(cli *client.Client, db *storage.DB) *SystemHandlers {
	return &SystemHandlers{docker: cli, db: db}
}

// Info returns Docker system-level information.
func (h *SystemHandlers) Info(w http.ResponseWriter, r *http.Request) {
	info, err := h.docker.Info(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, info)
}

// Version returns the Docker daemon version.
func (h *SystemHandlers) Version(w http.ResponseWriter, r *http.Request) {
	ver, err := h.docker.ServerVersion(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, ver)
}

// DiskUsage returns Docker disk usage statistics.
func (h *SystemHandlers) DiskUsage(w http.ResponseWriter, r *http.Request) {
	du, err := h.docker.DiskUsage(r.Context(), dockertypes.DiskUsageOptions{})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, du)
}

// HostStatsSample is a host-level CPU/memory/disk reading.
type HostStatsSample struct {
	CPUCores  int     `json:"cpu_cores"`
	CPUPct    float64 `json:"cpu_pct"`
	MemTotal  int64   `json:"mem_total"`
	MemUsed   int64   `json:"mem_used"`
	DiskTotal int64   `json:"disk_total"`
	DiskUsed  int64   `json:"disk_used"`
}

// ComputeHostStats reads host CPU (/proc/loadavg ÷ NCPU), memory
// (/proc/meminfo MemAvailable) and disk (statfs of the Docker root) metrics.
// Shared by the HostStats handler and the background metrics sampler.
func ComputeHostStats(ctx context.Context, cli *client.Client) (HostStatsSample, error) {
	info, err := cli.Info(ctx)
	if err != nil {
		return HostStatsSample{}, err
	}

	// Memory: /proc/meminfo MemAvailable (free + reclaimable)
	memTotal := info.MemTotal
	memUsed := int64(0)
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "MemAvailable:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
						free := kb * 1024
						if memTotal-free > 0 {
							memUsed = memTotal - free
						}
					}
				}
				break
			}
		}
	}

	// CPU: 1-min load average / NCPU
	cpuPct := 0.0
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			if load, err := strconv.ParseFloat(fields[0], 64); err == nil && info.NCPU > 0 {
				cpuPct = math.Min(100, load/float64(info.NCPU)*100)
			}
		}
	}

	// Disk: statfs the first reachable candidate path. info.DockerRootDir is the
	// host's Docker data dir (e.g. /var/lib/docker) — accurate on bare metal, but
	// inside the backend container that host path doesn't exist (we talk to Docker
	// over the socket proxy, not a mounted dir), so statfs there fails and returns
	// zero. Fall back to Dockyard's own data volume (/data) and finally the
	// container root (/) — both live in the container and report the underlying
	// Docker filesystem, which is the disk that actually matters.
	diskTotal, diskUsed := int64(0), int64(0)
	for _, p := range []string{info.DockerRootDir, appDataDir, "/"} {
		if p == "" {
			continue
		}
		if t, u := diskStats(p); t > 0 {
			diskTotal, diskUsed = t, u
			break
		}
	}

	return HostStatsSample{
		CPUCores:  info.NCPU,
		CPUPct:    math.Round(cpuPct*10) / 10,
		MemTotal:  memTotal,
		MemUsed:   memUsed,
		DiskTotal: diskTotal,
		DiskUsed:  diskUsed,
	}, nil
}

// HostStats returns the current host-level CPU, memory, and disk metrics.
func (h *SystemHandlers) HostStats(w http.ResponseWriter, r *http.Request) {
	s, err := ComputeHostStats(r.Context(), h.docker)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, s)
}

// MetricsHistory returns the persisted host-load time-series for the requested
// range in seconds (default 1h, capped at 7d).
func (h *SystemHandlers) MetricsHistory(w http.ResponseWriter, r *http.Request) {
	rangeSec := 3600
	if v := r.URL.Query().Get("range"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			rangeSec = n
		}
	}
	if rangeSec > 7*24*3600 {
		rangeSec = 7 * 24 * 3600
	}
	samples, err := h.db.GetMetricHistory(rangeSec)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if samples == nil {
		samples = []storage.MetricSample{}
	}
	writeJSON(w, samples)
}
