# Dockyard — Design System

**Product:** Dockyard — an all-in-one Docker manager. Rich feature surface, sleek and premium, optimized for serious developers and enterprise teams. Lives where the developer lives: dense, dark-first, keyboard-friendly, mono-comfortable.

> **Brand note.** No codebase, Figma, or prior assets were attached when this system was started. The product description used ("Docker Manager — an all-in-one docker manager rich with features, sleek, premium and optimised for a true developer and enterprise experience") was translated into a fresh brand direction codenamed **Dockyard**. Everything below — the name, the wordmark, the palette, the type pairing — is a first-pass proposal. **Treat it as a starting point and iterate.**

## Sources & inputs

| Type | Reference | Status |
|---|---|---|
| Codebase | _none provided_ | — |
| Figma | _none provided_ | — |
| Slide deck | _none provided_ | — |
| Brand assets | _none provided_ | — |
| Brief | one-line product description (above) | used as direction |

If you can hand over a real repo, design file, or marketing site, this whole system should be re-grounded against the real source of truth.

---

## Index

```
.
├── README.md                  ← this file
├── SKILL.md                   ← portable skill manifest (Claude Code compatible)
├── colors_and_type.css        ← design tokens — colors, type, spacing, motion
├── assets/                    ← logo marks, brand glyphs, generic illustrations
├── fonts/                     ← (none — Geist loads from Google Fonts; see notes)
├── preview/                   ← Design System tab cards (foundations & components)
├── ui_kits/
│   ├── app/                   ← the Dockyard application (dashboard, containers, terminal)
│   └── marketing/             ← the marketing site (hero, features, pricing, footer)
└── slides/                    ← (not present — no template was provided)
```

**Key files to skim in order:** `colors_and_type.css` → `preview/*.html` cards → `ui_kits/app/index.html` → `ui_kits/marketing/index.html`.

---

## Brand essence

**Name.** *Dockyard.* Maritime nod to Docker, single-word, premium, and not crowded with existing tools in the cloud-native space. Wordmark uses Geist with `-0.02em` tracking and a single tabular "■" container glyph as the brandmark.

**Tagline (proposed).** *Ship anything. From anywhere. With everything.*

**Audience.** Senior engineers, platform/devex teams, SREs, and engineering leadership at enterprises running container fleets. Comfortable in a terminal, intolerant of toy UIs.

**Position.** The Docker manager you'd actually pay for. Premium feel of Linear, terminal-fluency of Raycast, breadth of Docker Desktop, polish of Vercel.

---

## CONTENT FUNDAMENTALS

Dockyard copy reads like a competent senior engineer writing internal docs — terse, technical, never cute. Confidence without swagger.

**Voice principles**
- **Direct.** Skip throat-clearing. "Start container" not "Click here to start your container." Imperative verbs.
- **Lowercase product nouns.** *containers, images, volumes, networks, registries.* Never Title Case product surfaces.
- **Sentence case headings.** "Manage containers" not "Manage Containers". Capitalize only proper nouns and acronyms.
- **No exclamation marks. No emoji.** Status is communicated with color and shape, never `✅`.
- **Numbers are mono.** Container counts, ports, sizes, durations always render in Geist Mono with tabular figures.
- **You, not we.** Address the user directly. "You have 12 running containers." Avoid "We've detected…" — the tool acts, it doesn't announce itself.
- **No marketing-ese in-product.** No "powerful", "seamless", "unlock". These are tolerated *sparingly* in marketing copy.
- **Tense.** Present tense for state ("running", "exited"), past for events ("started 3m ago"), future only for scheduled actions.

**Microcopy patterns**

| Surface | Pattern | Example |
|---|---|---|
| Empty state | one line, then primary action | "No containers running. **Pull an image** to get started." |
| Confirmation | verb + object, no padding | "Stop nginx-prod?" / "Stop" — "Cancel" |
| Errors | what failed + why + next step | "Pull failed — registry timeout. Retry or change registry." |
| Toasts | past-tense outcome | "Container started." (not "Successfully started!") |
| Tooltips | ≤6 words, no period | "Restart and keep volumes" |
| Buttons | verb-first, 1–3 words | "Deploy", "Open shell", "Force remove" |
| Labels | sentence case, no colon | "Container name" not "Container Name:" |
| Meta | mono, abbreviated | `2.4 GB`, `3m ago`, `:8080`, `sha256:a1b2c3…` |

**Marketing voice example** (homepage hero):

> **Ship anything. From anywhere. With everything.**
> Dockyard is the docker manager built for teams that run real containers at real scale. Cluster-aware. Registry-native. Built to live in your terminal — and stay out of your way.

**Product voice example** (in-app empty state):

> **No containers yet**
> Pull an image from a registry, or start one from a compose file.
> [Pull image] [Open compose]

---

## VISUAL FOUNDATIONS

The system is **dark-first, dense, and rectilinear**. Inspired by the terminal, the manifest, the container — not the marketing page.

### Colors

- **Base palette.** A 12-step ink scale from `#05070C` (page) to `#FFFFFF`, biased slightly blue. Surfaces stack by elevation: `bg → bg-elevated → bg-raised → bg-hover → bg-pressed`. Borders carry visual separation, not shadows.
- **Brand accent.** Electric cyan (`#22D3EE`). One color, used surgically — primary buttons, focus rings, active nav, key data points. **Never** as a large fill or background gradient.
- **Status colors.** `running` (emerald), `warn` (amber), `danger` (red), `info` (blue), `idle` (slate). Each ships with a `-bg` translucent variant for badges and row highlights.
- **No purple/blue gradients. No rainbow accents.** One brand color, plus status. That's it.

### Type

- **Display & UI:** Geist (300 / 400 / 500 / 600 / 700). Tight tracking on display sizes (`-0.02em`), neutral on body.
- **Mono:** Geist Mono — used for all numerals (ports, sizes, durations, container IDs), code, kbd, terminal output, and *eyebrows* (small uppercase labels).
- **Hierarchy is set by weight + size, not color.** Headings shift toward `--ink-11`; body sits at `--ink-10`; metadata at `--ink-8`.
- **Density.** UI default is 13/20px. Code is 12–13px mono. Marketing uses larger sizes (16–84px) but with the same family.

> **Font substitution flag.** No font files were provided. Geist + Geist Mono are loaded from Google Fonts via `@import` in `colors_and_type.css`. If Vercel's licensed Geist files are preferred (or another house font entirely), drop the `.woff2` files into `fonts/` and swap the `@import` for a local `@font-face` block.

### Spacing

A strict 4px grid: `4 8 12 16 20 24 32 40 48 64 80 96`. Most in-app spacing lives at 8–16px (dense). Marketing breathes at 32–96px.

### Backgrounds & surfaces

- Solid colors first. **No photographic backgrounds in-product.** Marketing may use one full-bleed product screenshot per section.
- **Subtle grid overlay** on the marketing hero and "empty" canvas surfaces: 24px grid, `rgba(255,255,255,0.03)` lines. Echoes terminal/blueprint without being literal.
- **Hairline borders** (`rgba(255,255,255,0.06)`) instead of drop shadows on dark cards.
- **Inset wells** (`--bg-inset: #04060A`) for terminals, code blocks, and log panels — darker than the surrounding surface to read as "below" the UI.

### Animation

- **Default ease:** `cubic-bezier(0.16, 1, 0.3, 1)` — fast-out, gentle-in. Feels confident.
- **Durations:** 120ms (hover/state), 180ms (panel slides), 240ms (modals).
- **Springs are rare.** Used only on toggles and the brand mark on hover. Never on layout or text.
- **No bouncing, no parallax, no scroll-jacking.** Marketing scrolls naturally.
- **Loading.** Indeterminate work shows a 2px cyan progress bar at the top of the affected panel, not a spinner. Long operations stream log lines.

### Interactive states

| State | Treatment |
|---|---|
| Hover | Surface lifts one step (`bg → bg-hover`); text remains the same. No scale, no glow. |
| Press | Surface darkens one step (`bg-pressed`); shrinks `0.98` only on primary buttons. |
| Focus | 2px cyan ring (`--sh-focus`), inset 2px from element. No outline-offset hack. |
| Disabled | 50% opacity, no other change. Cursor `not-allowed`. |
| Selected | Cyan left-border (3px) on list rows; cyan background tint (8%) on chips. |
| Loading | Skeletons match final shape; mono numerals show `——` not spinners. |

### Borders & corners

- **Radii.** `3 / 5 / 7 / 10 / 14 / 20` plus full-pill. Chips at 3px, buttons at 7px, cards at 10px, modals at 14px, marketing hero shapes at 20px.
- **Borders are 1px, never thicker.** Strong borders are achieved by darkening the *color*, not the *width*.

### Shadow / elevation

Four levels (`--sh-1` to `--sh-4`). All shadows are large/soft and pure black, with a 1px inset highlight at the top for a subtle "lit from above" feel. Used **sparingly** — context menus, modals, the command palette. Cards lean on borders.

### Transparency & blur

- Used **only** for: command palette backdrop (12px blur, 60% opacity ink), context menu (8px blur), and the marketing nav after scroll (4px blur, 70% opacity).
- Never on body text. Never on data.

### Imagery

- **Product screenshots are the hero imagery.** Always rendered in actual product UI (Dockyard's own dark theme). Never mocked in light mode for marketing.
- If illustrations are needed, they are **isometric line drawings** in monochrome cyan-on-ink — containers as wireframe boxes, networks as nodes/edges. Never characters, never gradients, never 3D renders.

### Layout rules

- **App.** Fixed 248px left sidebar, fixed 48px top bar, optional 28px status bar at the bottom. The middle is a single resizable panel system. Detail views slide in from the right at 480px wide.
- **Marketing.** 1280px max-width container, 24px gutters at mobile, 64px at desktop. Section vertical rhythm is 96px desktop / 64px mobile.

### Card anatomy

A Dockyard card is:
```
background: var(--bg-elevated);
border: 1px solid var(--border);
border-radius: var(--r-lg);   /* 10px */
padding: var(--s-4);          /* 16px, more for marketing */
```
No drop shadow by default. Hover raises to `--bg-raised` and brightens the border to `--border-strong`.

---

## ICONOGRAPHY

Dockyard uses **[Lucide](https://lucide.dev)** as its icon system. Loaded via CDN. Lucide is open-source, 1.5px stroke, 24px grid, geometric — matches Dockyard's rectilinear, technical aesthetic precisely and is the contemporary default across premium developer tools (Vercel, Linear-adjacent, Supabase, etc.).

> **Substitution flag.** No codebase icons were provided. Lucide is the proposed default; swap if you have a proprietary set.

**Usage rules**
- Standard icon size in UI is **16×16**. Sidebar icons are 18×18. Marketing feature icons are 24×24.
- **Stroke weight stays at Lucide default (1.5px).** Do not embolden.
- Icons inherit color from `currentColor`. Default tone is `--fg-muted`; active nav and hover bump to `--fg-default` or `--accent`.
- Icons are **never decorative.** Every icon either represents a real noun (container, image, network) or a real verb (start, stop, restart, prune).
- **No emoji.** None. Not in product, not in marketing copy.
- **No unicode characters as icons** (no `✓`, no `→`, no `★`). Use Lucide's `check`, `arrow-right`, `star`.
- For status, prefer a **filled colored dot** (`●`) rendered as a span, not an icon — `running`, `paused`, `exited`, `error` are dots, sized 8px.

**Mapping (Docker concepts → Lucide icons)**

| Concept | Icon |
|---|---|
| Container | `box` |
| Image | `layers` |
| Volume | `database` |
| Network | `network` |
| Registry | `cloud` |
| Compose / stack | `boxes` |
| Logs | `scroll-text` |
| Terminal / shell | `terminal` |
| Build | `hammer` |
| Pull / push | `download` / `upload` |
| Settings | `settings` |
| Search | `search` |
| Filter | `list-filter` |
| Status: running | `●` (dot, `--running-400`) |
| Status: paused | `●` (dot, `--warn-400`) |
| Status: exited | `●` (dot, `--idle-400`) |
| Status: error | `●` (dot, `--danger-400`) |

**Logo / brandmark**

The Dockyard mark is a single solid square (`■`) — the universal "container" glyph — paired with the wordmark in Geist 600. The square is `--brand-400` on dark backgrounds, `--ink-1` on light. The mark is provided in `assets/` as standalone SVG, with the wordmark variant, and a square avatar version.

---

## Quick start (for designers + agents)

1. Always import `colors_and_type.css` in any artifact.
2. Use `--accent` (cyan) **sparingly**. If everything is cyan, nothing is.
3. Numbers in mono, status as dots, hierarchy by weight not color.
4. Density first. If something feels roomy, it probably is.
5. When in doubt, look at the app UI kit (`ui_kits/app/index.html`).
