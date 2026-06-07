// Package safe provides panic-recovery wrappers for goroutines. An unrecovered
// panic in any goroutine crashes the whole process (Go's default), which for a
// control plane means the API, WebSockets, watcher and all in-flight work go
// down together. Wrapping spawned goroutines contains a panic to that goroutine.
package safe

import "log"

// Recover logs and swallows a panic. Use as the first deferred call in a
// goroutine: `defer safe.Recover("watcher")`.
func Recover(name string) {
	if r := recover(); r != nil {
		log.Printf("[panic] recovered in %s: %v", name, r)
	}
}

// Go runs fn in a new goroutine with panic recovery.
func Go(name string, fn func()) {
	go func() {
		defer Recover(name)
		fn()
	}()
}
