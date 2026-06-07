# Dockyard — App UI Kit

A clickable, hi-fi recreation of the **Dockyard** application surface. This is the canonical reference for the in-product look and feel.

## What's in here

- **`index.html`** — the full app, running. Open it to see the assembled product. Lands on the **Dashboard**.
- **`Dashboard.jsx`** — big-screen overview: live clock, KPI cards w/ sparklines, host-resource rings, cluster throughput chart, project status grid, live activity feed, per-node load strip.
- **`ProjectsData.jsx` / `ProjectsPage.jsx` / `ProjectTabs.jsx` / `ProjectUpload.jsx`** — the full-lifecycle deployment manager (see below).
- **`Sidebar.jsx`** — left-rail navigation (Overview · Workspace · Build · Observe groups).
- **`TopBar.jsx`** — top bar (breadcrumb, palette trigger, profile).
- **`ContainerTable.jsx`** — the central data table for containers.
- **`DetailPanel.jsx`** — right-side container detail drawer (overview / logs / shell / ports / env / mounts).
- **`PagesData.jsx` / `PagesOps.jsx` / `PagesObs.jsx`** — Images, Volumes, Networks, Compose, Builds, Registry, Logs, Metrics, Events pages.
- **`StatusBar.jsx`** — bottom status bar with engine state.
- **`CommandPalette.jsx`** — `⌘K` palette overlay.
- **`bits.jsx`** — small atoms: `Btn`, `Badge`, `Dot`, `Kbd`, `Icon`, `Chip`.

## Projects — full deployment lifecycle

`ProjectsPage` is a left project list + right detail panel. Each project carries a status (idle/stopped · building · running · failed) reflected everywhere via colour-coded badges and animated dots — grey idle, pulsing amber building, green-glow running, red failed.

- **Adaptive action bar** — buttons change with status: Build → Run when idle, Cancel + live progress while building, Restart/Stop/Open while running, Retry + View logs on failure.
- **Logs tab** — separate Build-log and Run-log viewers, with an inline port-conflict resolution UI (remap host port or stop the conflicting container).
- **Files tab** — collapsible source file tree + a file preview pane.
- **Source tab** — lightweight Git: staged/unstaged change lists with stage/unstage, a diff viewer, commit box with optional author override, fetch/pull/push, commit history and branch switching.
- **Upload flow** — a two-step modal: drag-and-drop zone, then a preview pane (detected-type badge, key files, collapsible tree) plus a name/description/port-mapping form.

## What works (click-thru)

- Switch sections in the sidebar; breadcrumb follows.
- Dashboard clock ticks live.
- Projects: select from the list, switch detail tabs, run the adaptive action bar (Build animates a progress cycle → Running), resolve a port conflict, stage/unstage files, open the upload modal.
- Container list filter pills, row selection → detail panel, tab switching inside it.
- Command palette via `⌘K` / `Ctrl+K`.

## What's faked

Everything below the cosmetic layer. No real Docker engine, no real logs streaming, no auth, no networking — this is a pixel-fidelity surface for design work, not a working tool.
