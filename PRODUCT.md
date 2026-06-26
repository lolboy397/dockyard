# Product

## Register

product

## Users

Self-hosters, homelab operators, and small-team developers/DevOps who run Docker on
their own servers (a single host or a few). They're technically capable — comfortable
with containers, compose, and a terminal — but want a faster, safer way to operate
day-to-day than the raw CLI: starting/stopping containers, watching logs and metrics,
managing images/volumes/networks/stacks, and keeping the host clean.

Context: usually at a desk on desktop, and increasingly from a phone (Dockyard is an
installable PWA) to check on or fix something while away. They value control, clarity,
and trust — this tool touches real, often production, infrastructure.

## Product Purpose

Dockyard is a self-hosted Docker management UI (live in production, v0.0.1). It gives
operators a single, fast, legible control surface over their Docker host: containers,
images, volumes, networks, stacks, builds, registries, logs, metrics, events, backups,
users/roles, and native self-update.

Success = an operator can understand the state of their host at a glance and take the
right action — including undo and cleanup — without dropping to the CLI or second-
guessing what an action will do. Honesty about what is happening (real data, real
outcomes, clear reasons) is the product, not a feature of it.

## Brand Personality

Precise, calm, expert. The voice is a competent colleague: direct, unhurried, never
flashy or chatty. It states facts and outcomes plainly ("Removed 3 images · freed
1.2 GB · 1 skipped: in use by web-1"), shows real data instead of decoration, and
treats the user as capable. The emotional goal is confidence and trust — the operator
should feel in control and never be surprised by a destructive action. Quiet by
default; color and motion are reserved for meaning (status, change, risk).

## Anti-references

- **Generic Bootstrap/MUI admin templates** (user-named): purple primary, default
  component-library look, drop shadows everywhere, no point of view. Dockyard should
  feel authored, not scaffolded.
- **Cluttered legacy infra panels** (Portainer / cPanel / Synology DSM): density
  without hierarchy, dated chrome, everything the same visual weight. Dockyard is
  dense but scannable — hierarchy does the work, not boxes.
- The cross-cutting slop bans apply and contradict "precise, calm, expert": no gradient
  text, no decorative glassmorphism, no over-rounded cards, no hero-metric template,
  no crypto/AI-gradient dashboards.

## Design Principles

1. **Honest feedback over optimistic UI.** Show what actually happened — real counts,
   real reasons — never a client-side guess or a silent success/failure. (The prune
   redesign is the canonical example: itemized removed/skipped with the reason why.)
2. **Confidence before destruction.** Any irreversible action previews exactly what it
   will do, and explains why something can't be done. The safe option is the default;
   the aggressive one is opt-in and clearly labeled.
3. **Dense but scannable.** Pack real information, but let hierarchy, alignment, and
   restraint carry it — not boxes. Cards only when they are genuinely the right
   affordance.
4. **Color and motion mean something.** Reserve the status ramps and animation for
   state, change, and risk; stay quiet everywhere else.
5. **Works where the operator is.** Desktop-first density that adapts into a real
   native-feel phone PWA — the same control surface, not a stripped-down one.

## Accessibility & Inclusion

Best-effort; no formal WCAG bar is required. Keep the foundations already in place:
visible focus rings, keyboard navigation, `prefers-reduced-motion` alternatives, and
≥4.5:1 body contrast on the dark theme. Because status leans on red/green/amber, prefer
pairing color with an icon or label where practical (not a hard rule). Revisit a formal
AA target if the user base grows.
