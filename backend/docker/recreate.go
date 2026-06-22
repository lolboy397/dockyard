package docker

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
)

// RecreateOptions tunes how RecreateContainer rebuilds a container.
type RecreateOptions struct {
	// Pull pulls Config.Image before recreating, so a moving tag (e.g. :latest)
	// picks up the newer image.
	Pull bool
	// ClearHostname blanks Config.Hostname so the new container's hostname becomes
	// its own (new) ID — needed only for containers that self-inspect via
	// os.Hostname() (i.e. Dockyard's own backend).
	ClearHostname bool
}

// RecreateContainer rebuilds container `id` from its existing configuration,
// preserving volumes, ports, env, restart policy and — crucially — its network
// attachments and aliases, so service-name DNS keeps resolving after the swap.
//
// It creates the replacement under a temporary name BEFORE removing the old
// container (create-before-destroy): a broken new image or invalid config fails at
// create, leaving the existing container running untouched, instead of after it
// has already been torn down. Returns the new container's ID.
func RecreateContainer(ctx context.Context, cli *client.Client, id string, opts RecreateOptions) (string, error) {
	info, err := cli.ContainerInspect(ctx, id)
	if err != nil {
		return "", fmt.Errorf("inspect: %w", err)
	}
	if info.Config == nil || info.HostConfig == nil {
		return "", fmt.Errorf("container %s has no config to recreate from", id)
	}
	name := strings.TrimPrefix(info.Name, "/")
	service := info.Config.Labels["com.docker.compose.service"]

	if opts.Pull {
		rc, err := cli.ImagePull(ctx, info.Config.Image, image.PullOptions{})
		if err != nil {
			return "", fmt.Errorf("pull %s: %w", info.Config.Image, err)
		}
		_, _ = io.Copy(io.Discard, rc)
		rc.Close()
	}

	var nets map[string]*network.EndpointSettings
	if info.NetworkSettings != nil {
		nets = info.NetworkSettings.Networks
	}
	endpoints := buildRecreateEndpoints(nets, info.ID, service)

	if opts.ClearHostname {
		info.Config.Hostname = ""
	}

	netCfg, extra := splitPrimaryNetwork(string(info.HostConfig.NetworkMode), endpoints)

	// Create-before-destroy under a temp name. Creating doesn't bind host ports
	// (that happens at start), so it can't conflict with the still-running old one.
	tmpName := name + "-dyupd"
	_ = cli.ContainerRemove(ctx, tmpName, container.RemoveOptions{Force: true}) // clear any stale temp
	created, err := cli.ContainerCreate(ctx, info.Config, info.HostConfig, netCfg, nil, tmpName)
	if err != nil {
		return "", fmt.Errorf("create replacement (old container left running): %w", err)
	}

	// Replacement exists — retire the old container and take over its name.
	timeout := 30
	_ = cli.ContainerStop(ctx, id, container.StopOptions{Timeout: &timeout})
	if err := cli.ContainerRemove(ctx, id, container.RemoveOptions{}); err != nil {
		_ = cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true}) // don't leak the temp
		return "", fmt.Errorf("remove old: %w", err)
	}
	_ = cli.ContainerRename(ctx, created.ID, name) // best-effort; otherwise keeps the temp name

	for n, ep := range extra {
		_ = cli.NetworkConnect(ctx, n, created.ID, ep)
	}
	if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return created.ID, fmt.Errorf("start: %w", err)
	}
	return created.ID, nil
}

// buildRecreateEndpoints captures per-network endpoint settings for a fresh
// container: it keeps each network's aliases but drops the stale short-id alias
// and the old static IP (Docker assigns a new one), and ensures the compose
// service-name alias is present so service DNS survives the recreation.
func buildRecreateEndpoints(nets map[string]*network.EndpointSettings, oldID, service string) map[string]*network.EndpointSettings {
	out := map[string]*network.EndpointSettings{}
	oldShort := shortID(oldID)
	for netName, ep := range nets {
		var aliases []string
		if ep != nil {
			for _, a := range ep.Aliases {
				if a == oldShort {
					continue // the container's own id-as-alias is meaningless on the new one
				}
				aliases = append(aliases, a)
			}
		}
		if service != "" && !sliceContains(aliases, service) {
			aliases = append(aliases, service)
		}
		out[netName] = &network.EndpointSettings{Aliases: aliases}
	}
	return out
}

// splitPrimaryNetwork selects the network ContainerCreate attaches to (the one the
// old container used as its NetworkMode when possible) and returns the rest to be
// connected afterwards with NetworkConnect. Returns (nil, nil) when there are no
// networks to preserve.
func splitPrimaryNetwork(primaryHint string, endpoints map[string]*network.EndpointSettings) (*network.NetworkingConfig, map[string]*network.EndpointSettings) {
	if len(endpoints) == 0 {
		return nil, nil
	}
	primary := primaryHint
	if _, ok := endpoints[primary]; !ok {
		for n := range endpoints {
			primary = n
			break
		}
	}
	netCfg := &network.NetworkingConfig{
		EndpointsConfig: map[string]*network.EndpointSettings{primary: endpoints[primary]},
	}
	extra := map[string]*network.EndpointSettings{}
	for n, ep := range endpoints {
		if n != primary {
			extra[n] = ep
		}
	}
	return netCfg, extra
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func sliceContains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
