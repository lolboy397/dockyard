package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"docker-manager/backend/api/handlers"
	"docker-manager/backend/storage"

	dockercontainer "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// runAlertEvaluator periodically evaluates alert rules and fires/resolves them,
// recording each transition to the event log and (optionally) a webhook.
//
// Firing state is persisted per rule in the DB (not held in memory), so a
// restart neither re-fires nor re-notifies alerts that are already active, and a
// rule's "for" timer survives across restarts.
func runAlertEvaluator(ctx context.Context, cli *client.Client, db *storage.DB) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	evaluateAlerts(ctx, cli, db) // evaluate once at startup so state reconciles promptly
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			evaluateAlerts(ctx, cli, db)
		}
	}
}

func evaluateAlerts(ctx context.Context, cli *client.Client, db *storage.DB) {
	rules, err := db.ListAlertRules()
	if err != nil {
		return
	}
	var stats handlers.HostStatsSample
	for _, r := range rules {
		if r.Enabled && strings.HasPrefix(r.Type, "host_") {
			stats, _ = handlers.ComputeHostStats(ctx, cli)
			break
		}
	}
	now := time.Now()
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		active, msg := evalAlertRule(ctx, cli, rule, stats)
		switch {
		case active && !rule.Firing:
			// Condition holds but the rule hasn't fired yet. Honour the "for"
			// duration: the condition must persist for ForSeconds before firing.
			pendingSince := rule.PendingSince
			if pendingSince.IsZero() {
				pendingSince = now // first detection in this episode
			}
			if now.Sub(pendingSince) >= time.Duration(rule.ForSeconds)*time.Second {
				_ = db.SetAlertState(rule.ID, true, pendingSince)
				_ = db.LogEvent("alert", "system", "alert", rule.Name, "", "", msg)
				if rule.Channel == "webhook" && rule.WebhookURL != "" {
					postAlertWebhook(rule, msg)
				}
			} else if rule.PendingSince.IsZero() {
				_ = db.SetAlertState(rule.ID, false, pendingSince) // start the "for" timer
			}
		case !active && rule.Firing:
			_ = db.SetAlertState(rule.ID, false, time.Time{}) // resolve
			_ = db.LogEvent("alert_resolved", "system", "alert", rule.Name, "", "", rule.Name+" resolved")
		case !active && !rule.PendingSince.IsZero():
			_ = db.SetAlertState(rule.ID, false, time.Time{}) // condition cleared before firing — cancel pending
		}
	}
}

func evalAlertRule(ctx context.Context, cli *client.Client, rule storage.AlertRule, s handlers.HostStatsSample) (bool, string) {
	switch rule.Type {
	case "host_cpu":
		return s.CPUPct >= rule.Threshold, fmt.Sprintf("%s: host CPU %.0f%% ≥ %.0f%%", rule.Name, s.CPUPct, rule.Threshold)
	case "host_mem":
		pct := pctOf(s.MemUsed, s.MemTotal)
		return pct >= rule.Threshold, fmt.Sprintf("%s: host memory %.0f%% ≥ %.0f%%", rule.Name, pct, rule.Threshold)
	case "host_disk":
		pct := pctOf(s.DiskUsed, s.DiskTotal)
		return pct >= rule.Threshold, fmt.Sprintf("%s: host disk %.0f%% ≥ %.0f%%", rule.Name, pct, rule.Threshold)
	case "container_exited":
		list, err := cli.ContainerList(ctx, dockercontainer.ListOptions{All: true})
		if err != nil {
			return false, ""
		}
		var dead []string
		for _, c := range list {
			if c.State == "exited" || c.State == "dead" {
				name := c.ID[:12]
				if len(c.Names) > 0 {
					name = strings.TrimPrefix(c.Names[0], "/")
				}
				dead = append(dead, name)
			}
		}
		if len(dead) == 0 {
			return false, ""
		}
		return true, fmt.Sprintf("%s: %d container(s) exited — %s", rule.Name, len(dead), strings.Join(dead, ", "))
	}
	return false, ""
}

func pctOf(used, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return float64(used) / float64(total) * 100
}

func postAlertWebhook(rule storage.AlertRule, msg string) {
	body, _ := json.Marshal(map[string]any{
		"rule":      rule.Name,
		"type":      rule.Type,
		"message":   msg,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
	httpClient := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest(http.MethodPost, rule.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if resp, err := httpClient.Do(req); err == nil {
		resp.Body.Close()
	}
}
