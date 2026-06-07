package docker

import (
	"context"
	"fmt"

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
	// Ping to confirm connectivity.
	if _, err := cli.Ping(context.Background()); err != nil {
		return nil, fmt.Errorf("docker ping: %w", err)
	}
	return cli, nil
}
