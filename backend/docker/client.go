package docker

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/docker/docker/client"
)

// NewClient creates a new Docker client using environment variables / defaults
// and enables automatic API version negotiation.
func NewClient() (*client.Client, error) {
	cli, err := client.NewClientWithOpts(
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
		client.WithUserAgent("Docker-Client/27.5.1 (linux)"),
	)
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	// Ping to confirm connectivity. The Docker endpoint — the socket proxy in the
	// default compose stack — may not be accepting connections the instant the
	// backend starts, so retry with a bounded backoff instead of failing the whole
	// process on the first attempt (which would crash-loop the container on a
	// fresh deploy and leave it permanently "unhealthy").
	const maxAttempts = 30
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, lastErr = cli.Ping(ctx)
		cancel()
		if lastErr == nil {
			return cli, nil
		}
		log.Printf("[docker] endpoint not ready (attempt %d/%d): %v", attempt, maxAttempts, lastErr)
		time.Sleep(2 * time.Second)
	}
	return nil, fmt.Errorf("docker ping failed after %d attempts: %w", maxAttempts, lastErr)
}
