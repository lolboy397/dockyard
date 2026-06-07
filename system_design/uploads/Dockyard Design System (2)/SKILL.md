---
name: dockyard-design
description: Use this skill to generate well-branded interfaces and assets for Dockyard, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick reference

- **Brand:** Dockyard — premium docker manager for serious developers and enterprise teams. Dark-first, dense, terminal-fluent. Linear-x-Raycast-x-Vercel polish.
- **Tokens:** `colors_and_type.css` — the source of truth for every color, font, size, radius, shadow, motion curve. Always import this file before doing anything.
- **Type:** Geist (sans) + Geist Mono (mono). Loaded from Google Fonts. Mono for all numerals, ports, IDs, sizes, durations and uppercase eyebrows.
- **Color:** electric cyan `#22D3EE` accent on a 12-step ink scale. Status colors live separately (running / warn / danger / info / idle). **One** brand color — use sparingly.
- **Iconography:** Lucide via CDN, 1.5px stroke. 16px in UI, 20px in overviews, 24px in marketing. No emoji, no unicode arrows. Status is a colored dot, not an icon.
- **Density:** UI default font-size is 13/20px. Marketing default is 14–18px. Spacing is a strict 4px grid.
- **Components:** See `ui_kits/app/` for the in-product surface and `ui_kits/marketing/` for the marketing site.

## When you need an example

- Copy a component out of `ui_kits/app/` (e.g. `ContainerTable.jsx`, `DetailPanel.jsx`) and adapt — they're written to be lifted whole.
- For brand visuals, see `assets/` for the logo (mark, wordmark, light variant) and the two reference illustrations (isometric containers, network graph).
- For tone and voice, see the **CONTENT FUNDAMENTALS** section of `README.md`.
