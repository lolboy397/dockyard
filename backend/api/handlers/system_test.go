package handlers

import (
	"testing"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/build"
	containertypes "github.com/docker/docker/api/types/container"
	imagetypes "github.com/docker/docker/api/types/image"
	volumetypes "github.com/docker/docker/api/types/volume"
)

func TestDockerDiskSummary(t *testing.T) {
	du := dockertypes.DiskUsage{
		// 1000 of de-duplicated image layers. One image (600/100 shared) is used
		// by a container, the other (400) is dangling. Used = 600-100 = 500;
		// reclaimable = 1000 - 500 = 500.
		LayersSize: 1000,
		Images: []*imagetypes.Summary{
			{Containers: 1, Size: 600, SharedSize: 100},
			{Containers: 0, Size: 400, SharedSize: 0},
		},
		// One running (50, not reclaimable) + one exited (30, reclaimable).
		Containers: []*containertypes.Summary{
			{SizeRw: 50, State: "running"},
			{SizeRw: 30, State: "exited"},
		},
		// One in-use volume (200) + one orphan (300, reclaimable).
		Volumes: []*volumetypes.Volume{
			{UsageData: &volumetypes.UsageData{Size: 200, RefCount: 1}},
			{UsageData: &volumetypes.UsageData{Size: 300, RefCount: 0}},
		},
		// In-use cache (40) + stale cache (60, reclaimable) + shared (ignored).
		BuildCache: []*build.CacheRecord{
			{Size: 40, InUse: true},
			{Size: 60, InUse: false},
			{Size: 999, Shared: true},
		},
	}

	got := dockerDiskSummary(du)

	cases := []struct {
		name      string
		got, want int64
	}{
		{"images total", got.Images, 1000},
		{"containers total", got.Containers, 80},
		{"volumes total", got.Volumes, 500},
		{"build cache total", got.BuildCache, 100},
		{"grand total", got.Total, 1000 + 80 + 500 + 100},
		// reclaimable: images 500 + containers 30 + volumes 300 + cache 60 = 890.
		{"reclaimable", got.Reclaimable, 890},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d", c.name, c.got, c.want)
		}
	}
}

func TestDockerDiskSummaryHandlesUnavailableSizes(t *testing.T) {
	// -1 sentinels ("size not available") must not corrupt the totals.
	du := dockertypes.DiskUsage{
		LayersSize: 500,
		Images: []*imagetypes.Summary{
			{Containers: 1, Size: -1, SharedSize: -1}, // skipped → all 500 reclaimable
		},
		Containers: []*containertypes.Summary{
			{SizeRw: -1, State: "exited"}, // skipped
		},
		Volumes: []*volumetypes.Volume{
			{UsageData: &volumetypes.UsageData{Size: -1, RefCount: 0}}, // skipped
			{UsageData: nil}, // skipped
		},
	}

	got := dockerDiskSummary(du)
	if got.Total != 500 {
		t.Errorf("total = %d, want 500", got.Total)
	}
	if got.Reclaimable != 500 {
		t.Errorf("reclaimable = %d, want 500", got.Reclaimable)
	}
	if got.Containers != 0 || got.Volumes != 0 {
		t.Errorf("containers/volumes = %d/%d, want 0/0", got.Containers, got.Volumes)
	}
}
