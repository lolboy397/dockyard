package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	dockerpkg "docker-manager/backend/docker"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
)

// runSelfUpdate is the "self-update" subcommand. It runs in a short-lived helper
// container (the Dockyard backend image), launched detached from the main stack,
// so it can recreate the backend itself without dying mid-swap. It pulls each
// Dockyard service's image and recreates the container from its existing config.
//
// This is deployment-agnostic — it works under plain `docker compose`, Portainer,
// or `docker run`, because it never needs the compose file (which may live inside
// another tool's volume on an inaccessible path). Output goes to stdout so it is
// visible via GET /system/update/logs.
func runSelfUpdate(project string) {
	// Give the Apply HTTP response time to flush before we tear the stack down.
	time.Sleep(2 * time.Second)
	log.Printf("[self-update] starting (project=%q)", project)

	cli, err := dockerpkg.NewClient()
	if err != nil {
		log.Fatalf("[self-update] connect to docker: %v", err)
	}
	defer cli.Close()
	ctx := context.Background()

	ownID, _ := os.Hostname()

	list, err := cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		log.Fatalf("[self-update] list containers: %v", err)
	}

	type target struct{ id, name, service string }
	var targets []target
	for _, c := range list {
		if !strings.Contains(c.Image, "dockyard-") {
			continue // only Dockyard's own images (skip proxy / registry / others)
		}
		if c.Labels["dockyard.role"] == "updater" || (ownID != "" && strings.HasPrefix(c.ID, ownID)) {
			continue // never recreate the updater itself
		}
		if project != "" && c.Labels["com.docker.compose.project"] != project {
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		targets = append(targets, target{id: c.ID, name: name, service: c.Labels["com.docker.compose.service"]})
	}
	if len(targets) == 0 {
		log.Fatalf("[self-update] no Dockyard containers found to update")
	}

	// Recreate the backend last so the API (serving this update's response + the
	// client's poll) stays available as long as possible.
	sort.SliceStable(targets, func(i, j int) bool {
		return !isBackend(targets[i].name, targets[i].service) && isBackend(targets[j].name, targets[j].service)
	})

	// Emit a machine-parseable plan + per-step markers (alongside the human log
	// lines) so the UI can render a live step checklist by polling these logs —
	// the log is cumulative, so a client reconnecting after the backend restarts
	// still sees every step that happened during the gap.
	ids := make([]string, len(targets))
	for i, t := range targets {
		ids[i] = stepID(t.service, t.name)
	}
	log.Printf("[self-update] plan %s", strings.Join(ids, " "))

	failed := 0
	for _, t := range targets {
		id := stepID(t.service, t.name)
		if err := recreateContainer(ctx, cli, t.id, id); err != nil {
			log.Printf("[self-update] step %s failed", id)
			log.Printf("[self-update] FAILED %s: %v", t.name, err)
			failed++
		} else {
			log.Printf("[self-update] step %s done", id)
			log.Printf("[self-update] updated %s", t.name)
		}
	}
	if failed > 0 {
		log.Fatalf("[self-update] finished with %d failure(s)", failed)
	}
	log.Printf("[self-update] complete")
	log.Printf("[self-update] done — all services updated")
}

func isBackend(name, service string) bool {
	return strings.Contains(name, "backend") || strings.Contains(service, "backend")
}

// stepID is the stable identifier the UI keys progress steps on — the compose
// service name when present, else the container name. Must match how the backend
// labels components in gatherStatus.
func stepID(service, name string) string {
	if service != "" {
		return service
	}
	return name
}

// recreateContainer pulls the image a container runs and recreates the container
// from its existing config, preserving volumes, ports, env, restart policy and —
// crucially — its network attachments + service-name aliases (so e.g. the
// frontend keeps resolving the backend at "backend").
func recreateContainer(ctx context.Context, cli *client.Client, id, step string) error {
	info, err := cli.ContainerInspect(ctx, id)
	if err != nil {
		return fmt.Errorf("inspect: %w", err)
	}
	if info.Config == nil || info.HostConfig == nil {
		return fmt.Errorf("container has no config to recreate from")
	}
	imageRef := info.Config.Image
	name := strings.TrimPrefix(info.Name, "/")
	service := info.Config.Labels["com.docker.compose.service"]

	log.Printf("[self-update] step %s pulling", step)
	log.Printf("[self-update] pulling %s", imageRef)
	rc, err := cli.ImagePull(ctx, imageRef, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull %s: %w", imageRef, err)
	}
	_, _ = io.Copy(io.Discard, rc)
	rc.Close()

	// Capture network attachments + aliases. Drop the stale self-id alias and the
	// old static IP (let Docker assign); ensure the compose service-name alias is
	// present so service DNS keeps working after recreation.
	endpoints := map[string]*network.EndpointSettings{}
	if info.NetworkSettings != nil {
		oldShort := shortID(info.ID)
		for netName, ep := range info.NetworkSettings.Networks {
			var aliases []string
			for _, a := range ep.Aliases {
				if a == oldShort {
					continue
				}
				aliases = append(aliases, a)
			}
			if service != "" && !sliceHas(aliases, service) {
				aliases = append(aliases, service)
			}
			endpoints[netName] = &network.EndpointSettings{Aliases: aliases}
		}
	}

	// Clear the hostname so the new container's hostname becomes its own (new) ID,
	// keeping os.Hostname()-based self-inspection working in the recreated backend.
	info.Config.Hostname = ""

	// ContainerCreate connects to a single network; create with the primary (the
	// one the old container used as NetworkMode, if known) and connect the rest.
	var netCfg *network.NetworkingConfig
	extra := map[string]*network.EndpointSettings{}
	if len(endpoints) > 0 {
		primary := string(info.HostConfig.NetworkMode)
		if _, ok := endpoints[primary]; !ok {
			for n := range endpoints {
				primary = n
				break
			}
		}
		netCfg = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{primary: endpoints[primary]}}
		for n, ep := range endpoints {
			if n != primary {
				extra[n] = ep
			}
		}
	}

	log.Printf("[self-update] step %s recreating", step)

	// Create-before-destroy: build the replacement under a temporary name while the
	// current container is still running. Creating doesn't bind host ports (that
	// happens at start), so it can't conflict — but a broken new image or invalid
	// config fails HERE, leaving the existing container untouched and still up,
	// instead of after we've already torn it down.
	tmpName := name + "-dyupd"
	_ = cli.ContainerRemove(ctx, tmpName, container.RemoveOptions{Force: true}) // clear any stale temp from a prior failed run
	log.Printf("[self-update] creating replacement for %s", name)
	created, err := cli.ContainerCreate(ctx, info.Config, info.HostConfig, netCfg, nil, tmpName)
	if err != nil {
		return fmt.Errorf("create replacement (old container left running): %w", err)
	}

	// The replacement exists — now retire the old container and take over its name.
	timeout := 30
	log.Printf("[self-update] stopping %s", name)
	_ = cli.ContainerStop(ctx, id, container.StopOptions{Timeout: &timeout})
	if err := cli.ContainerRemove(ctx, id, container.RemoveOptions{}); err != nil {
		_ = cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true}) // don't leak the temp
		return fmt.Errorf("remove old: %w", err)
	}
	if err := cli.ContainerRename(ctx, created.ID, name); err != nil {
		// Non-fatal: the replacement still works under its temp name; just log it.
		log.Printf("[self-update] warn: rename %s -> %s: %v", tmpName, name, err)
	}

	for n, ep := range extra {
		if err := cli.NetworkConnect(ctx, n, created.ID, ep); err != nil {
			log.Printf("[self-update] warn: connect %s -> %s: %v", name, n, err)
		}
	}
	if err := cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	return nil
}

func sliceHas(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
