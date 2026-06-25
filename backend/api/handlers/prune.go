package handlers

import "strings"

// PruneItem is one resource a prune operation considered, with a per-item
// outcome. Reason is set only for skipped items (e.g. "in use by container web-1").
type PruneItem struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Size   int64  `json:"size,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// PruneResult is the unified, itemized result every prune endpoint returns so the
// UI can show exactly what was removed, what was skipped, and WHY — instead of a
// single opaque toast that reports a client-side guess.
type PruneResult struct {
	Kind      string      `json:"kind"` // images | containers | volumes | networks
	Removed   []PruneItem `json:"removed"`
	Skipped   []PruneItem `json:"skipped"`
	Reclaimed int64       `json:"reclaimed"`
}

func trimSHA(id string) string { return strings.TrimPrefix(id, "sha256:") }

func shortID(id string) string {
	id = trimSHA(id)
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// imageRepoTag returns the first real repo:tag for an image, or "<none>:<short id>"
// when it is untagged (dangling).
func imageRepoTag(tags []string, id string) string {
	for _, t := range tags {
		if t != "" && t != "<none>:<none>" {
			return t
		}
	}
	return "<none>:" + shortID(id)
}

// imageIsDangling reports whether an image has no usable tag (untagged layer).
func imageIsDangling(tags []string) bool {
	if len(tags) == 0 {
		return true
	}
	for _, t := range tags {
		if t != "<none>:<none>" {
			return false
		}
	}
	return true
}

// isAnonymousVolume reports whether a volume name looks like a Docker-generated
// anonymous volume id (64 lowercase hex chars). Docker's default VolumesPrune
// only removes these; named volumes need the all=true filter.
func isAnonymousVolume(name string) bool {
	if len(name) != 64 {
		return false
	}
	for _, c := range name {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
