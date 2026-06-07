//go:build !windows

package handlers

import "syscall"

// diskStats returns total and used bytes for the filesystem containing root,
// via statfs. This is the real implementation used on Linux (the OS the backend
// container runs on) and other Unix platforms.
func diskStats(root string) (total, used int64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(root, &stat); err != nil {
		return 0, 0
	}
	total = int64(stat.Blocks) * int64(stat.Bsize)
	avail := int64(stat.Bavail) * int64(stat.Bsize)
	if total-avail > 0 {
		used = total - avail
	}
	return total, used
}
