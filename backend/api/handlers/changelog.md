<!--
Dockyard changelog — rendered on the Updates page (Admin → Updates).

Format (kept deliberately simple so the backend can parse it without a markdown
library):
  ## <version> — <YYYY-MM-DD>     a release entry (newest first)
  ### <Category>                  a section: Added / Fixed / Changed / …
  - <text>                        an item under the current section (**bold** ok)

This file is embedded into the backend binary, so the running build always ships
its own history. Add a new "##" block at the top when you cut a release.
-->

## 0.0.4 — 2026-06-21

### Changed
- **Metrics overhaul** — the Metrics page now shows real host CPU, memory and disk (seeded from saved history so the charts aren't empty on load) plus live network throughput, with per-container memory and network breakdowns. Replaces the old placeholder "net in / net out" tiles.
- **Efficient multi-container logs** — the Logs page now streams every container over a single WebSocket instead of one per container (a 30-container page used to open 30 sockets), and adds select-all/none, an adjustable tail depth, line-wrap, and a download button.

### Added
- **App icon** — Dockyard now ships a stacked shipping-containers icon, used as the favicon and browser-tab icon.

## 0.0.3 — 2026-06-21

### Added
- **Event mute filters** — silence noisy events (e.g. a watchtower that constantly starts and exits). Right-click any event to mute things like it, manage rules from the new Filters panel, and toggle muted events back into view at any time.
- **Live project ports** — the Projects page now shows the ports a project's container is actually publishing, matching the Containers page, instead of only the declared configuration.
- **Changelog** — the Updates page now lists the features and fixes included in each release.

### Fixed
- Triggering a build twice in quick succession (or a deploy-on-push during a build) could start two builds at once and orphan the cancel handle — builds are now guarded so only one runs per project.
- The 30-minute build timeout is released as soon as a build finishes, instead of lingering until the deadline.
- Remapping a conflicting host port no longer corrupts unrelated port mappings.
- Self-update now creates the replacement container before removing the old one, so a bad image leaves the current version running.

## 0.0.2 — 2026-06-20

### Added
- **Native self-update** — check for and apply updates to Dockyard's own images from Admin → Updates, with a live step-by-step progress checklist.
- Redesigned the Updates page into a two-column layout with the updater output in a side rail.

### Changed
- Self-update recreates containers in place from their existing configuration, so it works regardless of how the stack was deployed (Compose, Portainer, …).

## 0.0.1 — 2026-06-08

### Added
- First public release of Dockyard.
