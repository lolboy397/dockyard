//go:build windows

package handlers

// diskStats is a no-op on Windows. The backend ships and runs inside a Linux
// container, where system_unix.go provides the real statfs-based values. This
// stub exists only so the package compiles and `go test ./...` runs on a
// Windows development machine.
func diskStats(root string) (total, used int64) {
	return 0, 0
}
