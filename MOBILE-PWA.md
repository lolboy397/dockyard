# Mobile / PWA plan

## 1. Goal & scope

Turn the Dockyard Angular 19 frontend into an **installable, native-feel Progressive Web App optimised for phones** (with tablet and desktop kept fully functional). Concretely:

- **Installable** on Android Chrome (manifest + service worker + `beforeinstallprompt`) and iOS Safari (Add to Home Screen + apple meta tags + splash screens).
- **Native-feel on phone**: bottom tab navigation, safe-area handling (top/bottom **and** landscape left/right insets), route transitions, touch-first interactions (long-press menus, pinch/pan topology, touch tooltips), card layouts instead of horizontal-scroll tables, bottom-sheet modals, 16px inputs (no iOS zoom), 44px tap targets.
- **Resilient on mobile networks**: app-shell offline boot, reconnect-on-foreground for WebSockets, visibility-gated polling, offline/connecting banner, token survives offline relaunch.
- **Fast**: tree-shaken Lucide with per-element rendering (drop ~100 KB gzip and the whole-document re-scan), trimmed fonts, tightened budgets, Lighthouse-gated in CI.

**Non-goals:** full offline operation (the app manages a live Docker daemon — offline = shell + last-cached state only), push notifications, background sync (unsupported on iOS standalone).

**Primary device targets:** iPhone (Safari 16.4+, standalone) is the hardest constraint and the design anchor; Android Chrome 120+; iPad Safari (including split-view / Slide Over); desktop Chrome/Firefox/Safari for regression.

## 2. Current state (honest inventory)

**Already in place / responsive:**
- **Responsive shell.** CSS grid shell (`styles.scss:212-218`); collapses at ≤820px to off-canvas left drawer (`styles.scss:1758`); second breakpoint at ≤480px (`styles.scss:1819`). Topbar hides search ≤820px, divider ≤480px.
- **All 23 routes lazy-loaded** via `loadComponent()` (`app.routes.ts`). No eager route imports.
- **Topology touch already implemented**: one-finger pan + two-finger pinch-zoom (`topology.component.ts:284-316`, wired `topology.component.html:48`); `touch-action:none` on `.topo-viewport` (`topology.component.scss:26`); `fitView()` (`topology.component.ts:334-343`).
- **Fluid charts already done**: dashboard host-load chart (`viewBox 0 0 480 120`, `preserveAspectRatio=none`, `vector-effect=non-scaling-stroke`), metrics sparklines (`0 0 200 60`) and CPU chart (`0 0 600 140`) all scale to 100% width.
- **Self-hosted assets, offline-safe**: Lucide vendored at `public/lucide.min.js`; Geist/Geist Mono via `@fontsource` (bundled). No CDN dependencies (despite the `icon.component.ts` docstring still saying "CDN").
- **`provideAnimationsAsync()` registered** (`app.config.ts:15`) and `@angular/animations` in deps — but **zero animation triggers defined**.
- **Realtime/WS infra**: `RealtimeService` with `visibilitychange`+`focus` resync (`realtime.service.ts:45-46`), capped backoff reconnect; multiplexed logs and per-container stats reconnect with backoff.
- **Existing CSP is a full policy** (`nginx.conf:36`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. HTTPS on 443/9273; HTTP on 80/9272 (no redirect, no HSTS).
- **Reduced-motion already partially handled**: `context-menu.scss:33` and `auth-background.component.ts:36` gate on `prefers-reduced-motion`.
- **Tests**: 13 Jasmine specs (`docker.service` x5, `confirm-dialog` x3, `status-dot` x5) run headless in CI; Go backend has race-tested suites. `skipTests:true` for all schematics — no component specs, no e2e.
- `apple-touch-icon.png` (180x180) present and linked (`index.html:11`).
- `@angular/material@^19.2.19` is a dependency (`package.json:20`) but is **unused** in `src/` (only `@angular/cdk` is imported); tree-shaken out of the bundle today.

**Entirely absent (zero PWA infra — confirmed):**
- No `manifest.webmanifest`, no `ngsw-config.json`, no `@angular/service-worker` in `package.json`, no `provideServiceWorker()` in `app.config.ts` (providers are exactly the 5 listed in `app.config.ts`), no `serviceWorker:true` in `angular.json`.
- No `theme-color`, no `apple-mobile-web-app-*` meta, no `viewport-fit=cover` (confirmed `index.html:7` is bare `width=device-width, initial-scale=1`).
- No 192/512/maskable icons, no splash screens.
- No `env(safe-area-inset-*)` anywhere; no bottom tab bar; no route transitions; no scroll restoration; no back-button drawer handling.
- No long-press directive (all 11 context-menu sites are `(contextmenu)`-only → dead on touch).
- No card layouts (every table → horizontal scroll, 640-700px min-width floor).
- No bottom-sheet modals; all inputs 12-14px (iOS auto-zoom); tap targets 22-34px.
- `streamAllStats()` has **no reconnect** (silent data-loss bug today, `websocket.service.ts:205-219`).

**Confirmed live bugs (not strictly PWA-gated but folded in):**
- `auth.service.ts:36` evicts the token on **any** `/me` failure including offline → logs the user out on every offline relaunch.
- `auth.interceptor.ts:22` has no `status===0` branch → network errors are treated as auth failures.
- `websocket.service.ts:205-219` `streamAllStats()` completes permanently on socket close with no reconnect.
- `icon.component.ts:41-45` calls `lucide.createIcons()` with **no root/element scoping** → every `dy-icon` paint re-scans and re-renders the entire document (O(n²) on icon-dense pages like Containers/Topology).

## 3. Phased implementation plan

Sequencing principle: **become installable as fast as possible** (Phase 1), then layer native-feel. The **"minimum installable" milestone is the end of Phase 1**.

---

### Phase 1 — PWA core: installable + offline shell

**Objective:** App is installable on Android + iOS, boots offline (shell only), self-hosts all assets, and survives offline relaunch without logging the user out. This is the minimum-installable milestone.

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|1.1|Install `@angular/service-worker@^19.2.0`; add `serviceWorker:true` + `ngswConfigPath` to **production** config (after `angular.json:98`); add `provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy:'registerWhenStable:30000' })` to providers|`frontend/package.json`, `frontend/angular.json`, `frontend/src/app/app.config.ts`|S|P0|
|1.2|Create `ngsw-config.json`: assetGroup `app` (prefetch) = `index.html,/manifest.webmanifest,/*.css,/*.js,/lucide.min.js,/*.woff2,/favicon.ico`; `icons` (lazy, prefetch-on-update) = `/**/*.png`; dataGroup `api` networkFirst, **2-3s timeout**, max 200, maxAge 1h over `/api/**`. Exclude `/ws/**` and `/auth/**` entirely (network-only). Set `navigationUrls: ['/**','!/api/**','!/ws/**','!/git/**','!/webhooks/**']` so the SW only does SPA fallback for real app routes (not git smart-HTTP or webhooks). woff2-only (no woff). Comment the WS/API constraint inline|`frontend/ngsw-config.json`|S|P0|
|1.3|Create `manifest.webmanifest`: `name/short_name='Dockyard'`, `description`, **`id:'/?source=pwa'`** (stable across re-deploys so Chrome never duplicates the install), `start_url:'/'`, `scope:'/'`, `display:'standalone'`, `orientation:'portrait-primary'`, **`launch_handler:{client_mode:'navigate-existing'}`**, **`categories:['developer-tools','productivity']`**, `theme_color:'#06B6D4'`, `background_color:'#05070C'`, icons 192/512 + 192/512 maskable + 180 (`apple-touch-icon.png`, purpose `any`), **1-2 `screenshots`** (one `form_factor:'narrow'`, one `'wide'`) for the richer Android install dialog. Add `<link rel="manifest">` to `index.html`|`frontend/public/manifest.webmanifest`, `frontend/src/index.html`|S|P0|
|1.4|Generate icon set: `icons/icon-192.png`, `icon-512.png`, `icon-192-maskable.png`, `icon-512-maskable.png` (maskable = brand bg fill, ~20% safe-zone — verify on maskable.app). Re-compress `apple-touch-icon.png` 30KB→<8KB; run all PNGs through oxipng/pngquant. Add narrow + wide `screenshots/*.png`|`frontend/public/icons/*`, `frontend/public/screenshots/*`, `frontend/public/apple-touch-icon.png`|S|P0|
|1.5|Add iOS PWA meta to `index.html` head: `apple-mobile-web-app-capable=yes`, **`apple-mobile-web-app-status-bar-style=default`** (see 3.3 — `default` gives an opaque inset matching theme, avoiding white glyphs on the light theme; runtime-switched to `black-translucent` only while dark theme is active), `apple-mobile-web-app-title=Dockyard`, `mobile-web-app-capable=yes`, two `theme-color` metas (dark `#05070C`/light `#F6F8FB` via `prefers-color-scheme`)|`frontend/src/index.html`|S|P0|
|1.6|**Replace full Lucide UMD with tree-shaken ES subset AND fix the global re-scan**: `npm i lucide`; create `lucide-icons.ts` importing exactly the ~116 used icons (HTML templates + dynamic TS: `eventIcon` events.component.ts:209, `actIcon` dashboard.component.ts:324, `typeIcon` projects.component.ts:1430, `fileMeta` volume-explorer.data.ts:70, `admin.data.ts`, `auth-background.component.ts:75`, `CR_ICONS` roles.component.ts:36). Rewrite `icon.component.ts` to (a) drop `declare const lucide`, (b) **render only this host element's icon** (build the SVG node directly from the imported icon, not call a global `lucide.createIcons()` that re-scans the whole document — fixes the O(n²) paint), (c) `console.warn` + `box` fallback for unknown names (e.g. backend-supplied `role.icon`), (d) update the stale "CDN" docstring at lines 6-7. Remove `<script src=lucide.min.js>` (`index.html:19`) and delete `public/lucide.min.js`. ~100KB gzip saved + per-element render. Inline bootstrap is forbidden by `script-src 'self'`, so this bundle approach is mandatory|`frontend/src/app/lucide-icons.ts`, `frontend/src/app/components/shared/icon/icon.component.ts`, `frontend/src/index.html`, `frontend/public/lucide.min.js`|M|P0|
|1.7|*(Stopgap if 1.6 slips)* add `defer` to the same-origin lucide script (allowed under `script-src 'self'`); call a scoped render in `app.component` after rAF so first paint isn't blank|`frontend/src/index.html`, `frontend/src/app/components/shared/icon/icon.component.ts`|S|P0|
|1.8|**Fix `init()` token eviction when offline** (`auth.service.ts:36`): split the error path — on network error (`HttpErrorResponse status===0` / `ProgressEvent`) keep the token + set authed optimistically and resolve `ready=true`; only remove the token on a genuine 401|`frontend/src/app/auth/auth.service.ts`|S|P0|
|1.9|**Differentiate network errors from 401** in interceptor (`auth.interceptor.ts:22`): add an explicit `status===0` branch that re-throws without `handleUnauthorized()`|`frontend/src/app/auth/auth.interceptor.ts`|S|P0|
|1.10|Add `worker-src 'self'` to CSP for explicitness *(note: `default-src 'self'` already covers worker-src so SW registration likely already works — verify; this may be a documentation-only no-op)*. Document optional `ENABLE_HSTS` toggle + `Strict-Transport-Security` for real-TLS deploys|`frontend/nginx.conf`|S|P1|
|1.11|App-shell offline boot: detect `!navigator.onLine` on init, show "You are offline — connect to your Dockyard host" card instead of blank/spinner. Cover the **logged-out** cold launch too: offline boot with no token (or expired token) must land on the login screen with an offline affordance, never an infinite spinner|`frontend/src/app/app.component.ts/.html/.scss`, login-screen, `frontend/ngsw-config.json`|M|P0|
|1.12|`PwaUpdateService`: subscribe `SwUpdate.versionUpdates`, filter `VersionReadyEvent`, show a **dismissable-with-persistence** "New version available" banner that applies the update on next navigation/idle (not a forced reload) and is **guarded so it never reloads while a modal is open or a form is dirty**. Also subscribe `SwUpdate.unrecoverable` → hard reload **with cache clear** so a wedged SW self-recovers. Wire into `AppComponent`|`frontend/src/app/services/pwa-update.service.ts`, `frontend/src/app/app.component.ts`|S|P1|
|1.13|`PwaModeService` (`isStandalone` signal from `matchMedia('(display-mode: standalone)').matches` OR `navigator.standalone===true`, plus `appinstalled` listener) — single source of truth reused by 1.14, 3.1 and 5.10. Android install: `InstallPromptService` (capture `beforeinstallprompt`, `canInstall` signal) + `InstallBannerComponent` (dismissable bottom banner, `dy_install_dismissed` in localStorage). **Banner is suppressed whenever `isStandalone`**|`frontend/src/app/services/pwa-mode.service.ts`, `frontend/src/app/services/install-prompt.service.ts`, `frontend/src/app/components/shared/install-banner/*`, `frontend/src/app/app.component.ts/.html`|S|P1|
|1.14|iOS Add-to-Home-Screen guidance: in install-banner detect iOS (`iPhone`/`iPad`) + `navigator.standalone!==true` + Safari (not Chrome-on-iOS); show "tap Share then Add to Home Screen" with Share icon. **Suppressed when `PwaModeService.isStandalone`**|`frontend/src/app/components/shared/install-banner/*`|S|P1|
|1.15|Tighten budgets (`anyComponentStyle` 32→16KB; `initial` warn/error ceilings) and enable `inlineCritical:true`. CSP `style-src` already includes `'unsafe-inline'`, so `inlineCritical` is **safe today** — no CSP change needed. **Validate the new `initial` ceiling against a real prod build first** (confirm current size before setting an error cap); consider removing the unused `@angular/material` dep as a cheap win|`frontend/angular.json`, `frontend/package.json`|S|P1|
|1.16|Trim fonts: drop `geist-sans/300.css` (unused `--fw-light`, −33KB); switch geist-mono to `latin-400/latin-ext-400` etc. (−46KB)|`frontend/angular.json`|S|P1|
|1.17|iOS splash screens (`apple-touch-startup-image`): generate 6-8 PNGs (iPhone SE→Pro Max + key iPad) in `public/splash/`, add media-query `<link>`s|`frontend/src/index.html`, `frontend/public/splash/`|M|P1|
|1.18|Preload hints for `geist-sans-latin-400`/`600` in `index.html`|`frontend/src/index.html`|S|P2|

**Exit criteria:**
- Installability verified: manifest valid (lint), SW registered+activated (`navigator.serviceWorker.controller` set), HTTPS context, icons ≥192+512, `display:standalone`, `start_url` responds 200 offline. (Do **not** rely on a Lighthouse "PWA category" — it was removed in LH 12; see testing.)
- Android: install bottom-sheet fires, launches standalone, theme colour correct in task switcher; install banner hidden once installed.
- iOS Safari: Add to Home Screen → correct icon, splash (no white flash), standalone, no Safari chrome; install hint hidden once standalone.
- Offline: DevTools offline reload renders shell from cache; API fails fast (≤3s) to graceful empty/offline state; logged-out offline cold launch shows the login screen, not a spinner.
- **Offline relaunch keeps the user signed in** (token not evicted); genuine 401 still logs out.
- SW caches contain no `/ws/*` or `/api/*` entries; navigation fallback excludes `/git/**` and `/webhooks/**`; only woff2 fonts cached; precache <1MB.
- Lucide subset: all icons across all 23 routes render (incl. dynamic `eventIcon`/`actIcon`/`fileMeta`/`role.icon` with `box` fallback); no separate ~393KB asset; no whole-document re-scan; bundle within tightened budget.

---

### Phase 2 — Touch interactions & gestures

**Objective:** Every touch user can reach all actions: long-press menus on all 11 surfaces, working topology selection/highlight on touch, touch chart tooltips, tap-to-dismiss backdrops.

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|2.1|Create `LongPressDirective` (`dyLongPress`): touchstart→500ms timer, cancel on touchmove >10px/touchend; on fire call `ContextMenuService.open(null, items, {x,y})`. `@Input() dyLongPress`, `dyLongPressHeader`. `touch-action:pan-y`; `preventDefault` on touchend to suppress iOS native menu; `-webkit-touch-callout:none`|`frontend/src/app/directives/long-press.directive.ts`|M|P0|
|2.2|Wire `[dyLongPress]`/`[dyLongPressHeader]` alongside existing `(contextmenu)` on all 11 sites: container-list:78, image-list:104, network-list:42, stack-list:102, projects:45, volume-list:46, volume-explorer:162 & :196, events:116, system-backup:89 & :142. Import directive per component|9 component HTML + their `.ts` imports|S|P0|
|2.3|ContextMenu touch fixes: add `(touchstart)='svc.close()'` to backdrop (`context-menu.component.ts:26`); make submenus open on `(click)`→`positionSub(idx)` instead of `(mouseenter)` (`menu-list.component.ts:101-103`)|`context-menu.component.ts`, `menu-list.component.ts`|S|P0|
|2.4|Topology touch-select + highlight: on touch, distinguish tap (<400ms) = select vs pan; replace `(mouseenter)/(mouseleave)` highlight with `(pointerenter)/(pointerleave)` or `(touchstart)`→`hoverId.set(n.id)`; `stopPropagation()` vs pan handler. **Register touchmove via `addEventListener(..., {passive:false})`** (not template binding) so `preventDefault()` works on iOS Safari 17+|`topology.component.ts/.html`|S|P1|
|2.5|Metrics touch tooltips: add touch handlers to sparklines (`metrics.component.html:25`) and CPU chart (`:60-61`); `onSparkTouch`/`onCpuTouch` reuse mousemove logic via `touches[0]`. **Register touchstart via `addEventListener(...,{passive:false})`** (template `preventDefault` is ignored on iOS 17+); `touch-action:pan-y` on SVG cards so vertical page scroll survives|`metrics.component.html/.ts`|S|P1|
|2.6|Events mute button on touch: `@media (pointer:coarse)` set `.event-mute { opacity:.55; pointer-events:auto }` and size ≥32px (currently 22px hover-only at `events.component.scss:77-81`)|`events.component.scss`|S|P1|
|2.7|Users/Roles modal backdrops: add `(touchstart)` (movement-thresholded) alongside `(mousedown)` (users:238, roles:143)|`users.component.html`, `roles.component.html`|S|P1|
|2.8|Projects mobile file fallback: visible `<input type=file accept=.zip,.tar.gz>` shown `@media (pointer:coarse)` (webkitdirectory at projects.component.html:713 dead on iOS)|`projects.component.html/.ts`|S|P2|
|2.9|`user-select:none` on `.ctable-row,.gtable-row,.stack-head,.event-row,.proj-item` (prevent OS text-selection stealing long-press)|`frontend/src/styles.scss`|S|P1|

**Exit criteria:** long-press opens correct menu on all 11 surfaces (iOS + Android); backdrop tap dismisses instantly; submenus open on tap; iOS native long-press suppressed; topology select+highlight+pan/pinch all work on touch with no console passive-listener warnings; metrics tooltips respond to touch while page still scrolls; events mute tappable; Users/Roles modals close on tap-outside. **Desktop right-click regression: all 11 still work.**

---

### Phase 3 — Navigation native-feel (bottom tabs, safe-area, transitions, status bar)

**Objective:** Phone primary nav via bottom tab bar; content clears notch/Dynamic Island/home-indicator (portrait **and** landscape); route changes animate; back button dismisses overlays; no tap-flash / pull-to-refresh.

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|3.1|**Bottom tab bar** (≤820px): Dashboard/Containers/Logs/Metrics/More(opens sidebar drawer). `position:fixed;bottom:0;height:calc(56px + env(safe-area-inset-bottom))`; active=`--accent`; add matching `padding-bottom` to `.page-body`; hide `.statusbar` ≤820px (move engine status into drawer/topbar). When `PwaModeService.isStandalone`, tab bar is primary nav and the hamburger is hidden. Sidebar retains all 20+ routes for More|`app.component.html/.ts`, `frontend/src/styles.scss`|M|P0|
|3.2|**Safe-area (all four edges)**: `viewport-fit=cover` in `index.html:7`; `.app` `height:100vh`→`100dvh` (fallback `100vh`); `padding-top:env(safe-area-inset-top)` on `.topbar` + `.sidebar`; bottom-inset on tab bar; **`env(safe-area-inset-left/right)` on topbar, bottom tab bar, and sidebar** so landscape notched/Island iPhones don't clip|`frontend/src/index.html`, `frontend/src/styles.scss`|S|P0|
|3.3|PWA status-bar/theme reconciliation (single source of truth with 1.5): `default` status-bar-style by default (opaque inset matching theme). In `toggleTheme()` (`app.component.ts:198`) update both the `theme-color` meta **and** the `apple-mobile-web-app-status-bar-style` (use `black-translucent` only while dark theme is active, `default` for light — otherwise white status-bar glyphs vanish on the light `#F6F8FB` background)|`frontend/src/index.html`, `app.component.ts`|S|P0|
|3.4|Suppress iOS tap-highlight (`-webkit-tap-highlight-color:transparent` on `a,button,[role=button],.nav-item,.ctable-row,.gtable-row`) + `touch-action:manipulation` on `.btn,.icon-btn,.nav-item,.nav-toggle` (kill 300ms delay)|`frontend/src/styles.scss`|S|P1|
|3.5|`overscroll-behavior:none` on `html,body`; `overscroll-behavior:contain` on `.sidebar-nav,.page-body` inner scrollers, `.logs-stream`, `.detail` (stop PWA pull-to-refresh / standalone blank-bounce)|`frontend/src/styles.scss`|S|P1|
|3.6|Momentum scrolling (`-webkit-overflow-scrolling:touch`) on `.sidebar-nav`,`.detail`,`.logs-stream`, vertical `.page-body` scrollers|`styles.scss`, `logs-page.component.ts`, `container-detail.component.ts`|S|P1|
|3.7|**Route transitions**: `routeFade` trigger (enter 180ms slide-fade `translateX(12px)→0`; leave 120ms opacity) on a `position:relative;overflow:hidden` wrapper around `<router-outlet>`; skip on initial load. (`provideAnimationsAsync` already registered)|`app.component.ts/.html`, `styles.scss`|M|P1|
|3.8|**Back button dismisses overlays**: on drawer open `history.pushState({drawer:true})`; `@HostListener('window:popstate')` closes drawer instead of navigating; same for full-screen `.detail` overlay (container-detail.component.ts:68). Test open-navigate-back-back sequences|`app.component.ts`, `container-detail.component.ts`|M|P1|
|3.9|Phone topbar slimming (≤820px): brand/title + search-icon + avatar; hide `.nav-toggle` (when standalone) and `.notif-wrap`; account for `safe-area-inset-top`|`app.component.html`, `styles.scss`|S|P2|
|3.10|Scroll restoration: `withInMemoryScrolling({scrollPositionRestoration:'enabled',anchorScrolling:'enabled'})` + per-component `ScrollStateService` for internal `overflow:hidden` panes (reference impl: Containers list)|`app.config.ts`, `app.routes.ts`, `container-list.component.ts`|M|P2|

**Exit criteria:** bottom tabs render+route on real iPhone standalone, clear home indicator; topbar clears notch/Dynamic Island in **portrait and landscape** (left/right insets); status bar colour/style matches theme in both dark and light; back closes drawer/detail before navigating; no pull-to-refresh in standalone; route transition ≤200ms, no double-render; no tap-flash; focus rings preserved for keyboard. Engine-status still surfaced on phone.

---

### Phase 4 — Lists→cards & forms→bottom-sheets

**Objective:** No horizontal-scroll tables on phone for high-traffic pages; modals become bottom sheets; inputs don't trigger iOS zoom; correct keyboards; validation feedback.

**4a — Lists to cards** (shared mixin first):

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|4.1|Shared card utilities `.list-card`,`.list-card-primary`,`.list-card-secondary`,`.list-card-actions`|`frontend/src/styles.scss`|S|P1|
|4.2|**Containers** card layout + **CDK virtual-scroll fix**: use `BreakpointObserver` (from `@angular/cdk`, already a dep — reacts to live resize so iPad split-view + rotation are covered); when mobile render a plain `@for` (not `cdk-virtual-scroll itemSize=42`/minBufferPx=420/maxBufferPx=840 from container-list.component.html:73 — wrong for multi-line cards). **Do not** use AutoSizeVirtualScrollStrategy (experimental, ships from `@angular/cdk-experimental` which is not a dep). Add `overscroll-behavior:contain` on the `cdk-virtual-scroll-viewport` and `.logs-stream` as an explicit item. 2-row card: [dot·name·id·badge] / [image·cpu·mem·started]|`container-list.component.html/.ts`, `styles.scss`|M|P0|
|4.3|**Events** stacked card (highest-traffic): icon-rail + [type·obj] / [time·actor·note]; remove 640px floor; mute ≥44px|`events.component.scss`, `styles.scss`|S|P0|
|4.4|Images card (drop 660px floor; checkbox tap-friendly)|`image-list.component.html/.scss`, `styles.scss`|S|P1|
|4.5|Stacks: collapse 5 head buttons to icon-only/ellipsis; `.stack-svc` 7-col→2-line card|`styles.scss`, `stack-list.component.html`|S|P1|
|4.6|Volumes card (mountpoint→tertiary truncated)|`volume-list.component.html`, `styles.scss`|S|P1|
|4.7|Users card (avatar+name / role·status·2FA / last-active)|`users.component.html/.scss`|S|P1|
|4.8|Builds definitions card|`builds.component.html/.scss`|S|P1|
|4.9|Alerts card (keep status toggle tappable)|`alerts.component.html/.scss`|S|P1|
|4.10|Backups history card|`system-backup.component.html/.scss`|S|P2|
|4.11|Roles card (4-col, simple)|`roles.component.html/.scss`|S|P2|
|4.12|Networks: keep horizontal scroll (dense mono) + visible scroll-shadow affordance|`network-list.component.html`, `styles.scss`|S|P2|

**4b — Charts/viz responsive:**

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|4.13|**Topology mobile-list fallback** (≤600px): `mobileView` signal driven by a **live `matchMedia`/resize listener** (not a one-time `window.innerWidth` read — current code reads it once, breaking iPad split-view/rotation) + `@else` scrollable lane/container list; graph/list toggle button. Coordinate z-index with bottom tab bar|`topology.component.html/.ts/.scss`|M|P0|
|4.14|Topology detail panel → full-screen sheet `@media (max-width:600px)` (`position:fixed;inset:0`); close button ≥44px|`topology.component.scss`|S|P0|
|4.15|Dashboard rings fluid (`viewBox 0 0 88 88` width:100%; keep `ringR=37`/`ringC`); KPI 2-col + projects 2-col + reduced header fonts `@media ≤480px`|`dashboard.component.html/.ts/.scss`|S|P1|
|4.16|Metrics bar charts: `@media ≤480px` shrink columns (160/80→90/72; net 120/150→90/100). Audit other `.bar-row` consumers before shipping global change|`styles.scss`, `metrics.component.scss`|S|P1|

**4c — Forms & modals to bottom-sheets:**

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|4.17|**Modals→bottom sheets** ≤820px: `.modal-backdrop{align-items:flex-end}`, `.modal{width:100%;max-width:100%;border-radius:r-lg r-lg 0 0;max-height:90svh}`, slide-up keyframe + drag-handle pill. Also `.amodal` + raw `upload-modal`/`bkp-modal`|`styles.scss`, `admin.scss`, `projects.component.html`, `system-backup.component.html`|M|P0|
|4.18|**iOS auto-zoom fix**: `@media ≤820px` set `font-size:16px` on `.input,.input-sm,.input-lg,.text-input,.palette-search input,.input-wrap input`|`styles.scss`, `auth.scss`|S|P0|
|4.19|**inputmode/type** on all inputs: numeric (projects ports :882/885, alerts :73/78), email (source :197/397), url (source :364, alerts :91, registry :27, builds :69, image pull), shell `inputmode=none enterkeyhint=send` (container-detail :316), decimal (container limits)|projects, alerts, source, registry, builds, container-list, image-list|S|P0|
|4.20|Modal footer above keyboard: primary mechanism is a **`visualViewport`-based handler** (`visualViewport.addEventListener('resize'\|'scroll')`) that translates the bottom sheet up by `(innerHeight − visualViewport.height)` — iOS does **not** fire window `resize` on keyboard show, so dvh/`env(keyboard-inset-height)` alone are unreliable on iOS 15-16 and are treated as progressive enhancement only. `max-height:calc(100dvh - 32px)`; safe-area padding on `.modal-foot`. Explicitly test on iOS 16|`styles.scss`, `index.html`, `modal.component.ts`|S|P1|
|4.21|Replace inline `grid-template-columns:1fr 1fr` in modals with `.field-row-2` class so `@media` stacking applies (stack-list:174, source:350/368, builds:54/72; inline styles beat `!important`, so this must be a class move)|`styles.scss`, stack-list, source, builds|S|P1|
|4.22|Inline validation (`.field-error`, template-driven `required`+`#x=ngModel`) on New alert / Deploy stack / Add registry / Clone repo|`styles.scss`, alerts, stack-list, registry, source|M|P1|
|4.23|Defer/skip autofocus on touch (source:331, projects:962, command-palette) — focus after sheet animation (~250ms), guarded by `pointer:coarse`|source, projects, modal.component.ts, command-palette.component.ts|S|P1|
|4.24|iOS webkitdirectory fallback (projects.component.html:713 — `webkitdirectory` + `multiple`, folder selection dead on iOS): feature-detect, toast "Folder upload unavailable on iOS — use .zip", auto-switch to zip flow|`projects.component.html/.ts`|S|P1|
|4.25|Admin role modal usable on phone: bottom-sheet `.amodal`; stack `.cap-edit-row`; `.seg-opt` ≥36px/13px; wrap `.icon-pick`|`admin.scss`, `roles.component.html`|M|P1|
|4.26|44px min targets in modals (`.modal .icon-btn,.amodal .icon-btn,.modal-foot .btn`) ≤820px|`styles.scss`, `modal.component.html`|S|P2|
|4.27|Scroll-into-view on `focusin` in `ModalComponent` (Android keyboard)|`modal.component.ts`|S|P2|

**4d — Global tap-target remediation:**

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|4.28|44px tap targets (prefer `@media (pointer:coarse)`): icon-btn 28→36 / sm 24→32; btn-sm 26→32; btn-xs 22→28; nav-item min-height 40; nav-toggle 34→44; avatar min 40 (negative margin); cm-item padding 6→10; touch-action:manipulation on rows|`styles.scss`, `context-menu.scss`, `events.component.scss`|M|P1|

**Exit criteria:** Containers/Events/Images/Volumes/Stacks/Users/Builds/Alerts render as cards at 390px with no horizontal scroll; CDK virtual scroll correct (no blank rows, correct thumb, `overscroll-behavior:contain`) with 100+ containers; topology auto-switches to list ≤600px (live on rotation/split-view) with full-screen detail; modals slide up as sheets with drag handle and footer visible above keyboard (via visualViewport on iOS); no input zoom on iOS for any modal/form; correct keyboards (numeric/email/url); validation errors show; bulk-select works on touch; desktop tables unchanged at 1440px.

---

### Phase 5 — Offline/realtime/perf hardening

**Objective:** WebSockets recover and don't drain battery; offline/connecting state is visible; SW boundaries and `wss://` derivation verified.

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|5.1|**`streamAllStats()` reconnect** (backoff like `connect()` :224-253). Fixes today's silent data-loss on containers/metrics/topology (`websocket.service.ts:205-219`)|`websocket.service.ts`|S|P0|
|5.2|**Verify `wss://` scheme derivation under HTTPS/standalone**: confirm `websocket.service.ts` builds `wsBase` from `location.protocol` (→ `wss://` on the 9273/HTTPS install context), not a hardcoded `ws://` — a `ws://` constant means every install has dead realtime (mixed-content blocked). Add the assertion as a test|`websocket.service.ts`|S|P0|
|5.3|Ensure ngsw network-only for `/ws/**`+`/api/**` (verifies 1.2; document constraint)|`ngsw-config.json`|S|P0|
|5.4|Pause/close high-freq streams on hidden, resume on show: extend `visibilitychange` in `RealtimeService` to close `/ws/events`; allstats consumers (container-list:235, metrics:73, topology:101) unsubscribe/resub; multiplexed logs (logs-page:78) pause/reopen|realtime.service.ts, websocket.service.ts, container-list, metrics, topology, logs-page|M|P1|
|5.5|Visibility-gate polling: dashboard 1s clock/5s stats/30s df (:42/46/49), metrics 3s (:72), app 60s (:230) — shared `visibilityAwareInterval`|dashboard, metrics, app.component|S|P1|
|5.6|Online/offline accelerated reconnect: `online`→immediate `open()`; `offline`→close+cancel timer (RealtimeService + multiLogs + allstats)|realtime.service.ts, websocket.service.ts|S|P1|
|5.7|`NetworkStatusService` (`isOnline` signal) + offline/connecting banner in shell; `online`→`resync$.next()`|network-status.service.ts, app.component.*|S/M|P1|
|5.8|`connected` signal from RealtimeService → live/reconnecting indicator (resurfaces engine status hidden by 3.1)|realtime.service.ts, app.component.*|S|P2|
|5.9|Client-side token expiry: persist `expires_at` (`dy_token_exp`); skip `/auth/me` if expired → login with "session expired"|auth.service.ts, auth.models.ts|S|P1|
|5.10|Logout SW cache clear (`caches.keys()`→`delete`), shared with the 1.12 unrecoverable-SW recovery path|auth.service.ts|S|P1|
|5.11|iOS 7-day eviction UX: "Session ended — sign in again" when `PwaModeService.isStandalone` and no token|login-screen.component.ts/.html|S|P2|

**Exit criteria:** allstats recovers ≤15s after socket kill; `wss://` confirmed in standalone with zero mixed-content errors; backgrounded tab sends no WS frames and fires no timers; airplane-mode→on reconnects <500ms; offline banner appears/clears within 2s; no spurious logout offline; SW cache contains no WS/API entries with SW active.

---

### Phase 6 — Polish (swipe / pull-to-refresh / motion)

**Objective:** Final native delight; reduced-motion compliance.

| # | Work item | File(s) | Effort | Pri |
|---|---|---|---|---|
|6.1|Opt-in pull-to-refresh on key list pages (containers/events) triggering resync — scoped to a **dedicated top sentinel/gesture zone**, not by relaxing `overscroll-behavior` on the whole scroller (which would re-introduce the iOS standalone blank-bounce)|container-list, events, shared util|M|P2|
|6.2|Swipe-to-dismiss on bottom sheets (drag handle → translateY, threshold close)|modal.component.ts, styles.scss|M|P2|
|6.3|**Extend existing** `@media (prefers-reduced-motion:reduce)` handling (already present in context-menu.scss:33 / auth-background) to cover sidebar slide, modal/sheet fade, route transition, topology auto-fit|styles.scss, app.component, topology|S|P2|
|6.4|`:focus-visible` rings (replace bare `outline:none` at styles.scss:551/569) + aria-labels on icon-only buttons (bell, avatar)|styles.scss, app.component.html|S|P1|

**Exit criteria:** pull-to-refresh/swipe-dismiss feel native and don't conflict with scroll or re-introduce standalone blank-bounce; reduced-motion removes all non-essential animation; keyboard focus rings visible; axe icon-button labels pass.

## 4. Cross-cutting concerns

- **Offline / asset self-hosting.** Lucide (tree-shaken into bundle, 1.6) and fonts (woff2 only, 1.16) must all be in the SW prefetch group or icons/fonts break offline; use globs, not hashed filenames (hashes change on `@fontsource` bumps). Hard rule: the app manages a **live daemon** — offline = shell + last-cached `/api` data via networkFirst **with a 2-3s timeout** so it fails fast to stale data instead of spinning.
- **CSP is a full policy** (`nginx.conf:36`), which has three consequences: (a) `style-src` already allows `'unsafe-inline'`, so `inlineCritical:true` (1.15) is safe **today** — no CSP edit required; (b) `script-src 'self'` forbids inline bootstrap, so the tree-shaken-into-bundle Lucide approach (1.6) is **mandatory** (the 1.7 stopgap loads an external same-origin file, which is permitted); (c) `default-src 'self'` already covers `worker-src`, so SW registration likely works without change — adding `worker-src 'self'` (1.10) is for explicitness, verify whether it is a no-op.
- **iOS Safari caveats.** No `beforeinstallprompt` (manual Share-sheet only → in-app hint 1.14, suppressed in standalone); `display:standalone` honoured only after Add-to-Home-Screen; `apple-mobile-web-app-capable` required for standalone; status-bar style must match theme (`black-translucent` only while dark — light theme needs `default` or white glyphs vanish, 3.3); `env(safe-area-inset-top)` mandatory under `black-translucent`; splash images are per-device static PNGs; SW caches evicted after ~7 days inactivity (graceful "session ended" 5.11); `localStorage` ~5MB / cache stay <50MB; **passive-listener trap**: `preventDefault()` in `(touchmove)`/`(touchstart)` template bindings is ignored on iOS 17+ → register via `addEventListener(...,{passive:false})` (topology touchmove 2.4; metrics touchstart 2.5); **iOS does not fire window `resize` on keyboard show** → use `visualViewport` to keep sheet footers above the keyboard (4.20); WebKit drops WS on backgrounding → reconnect-on-foreground is the architecture, not background sync.
- **Safe-area insets (four edges).** `viewport-fit=cover` + `env(safe-area-inset-*)` on topbar (top + left/right), bottom tab bar (bottom + left/right), sidebar drawer, modal-foot. Landscape on notched/Island iPhones moves insets to left/right (3.2). CDK-virtualised Containers and any fixed-height internal scrollers must add bottom-inset + tab-bar height or last rows hide permanently.
- **Live breakpoint reactivity.** Every mobile/desktop switch — bottom-tab vs sidebar (3.1), topology graph vs list (4.13), Containers virtual-scroll vs card `@for` (4.2) — must be driven by `matchMedia`/`BreakpointObserver` that updates on rotation and iPad split-view/Slide Over, never a one-time `window.innerWidth` read.
- **HTTPS / secure context.** SW only registers on 9273 (HTTPS); raw HTTP:9272 silently has no SW → no install, and Lighthouse/installability checks there always fail — run tests against 9273. `manifest.start_url` must be `/` under HTTPS; iOS won't install behind an untrusted cert (user must trust CA). WS must resolve to `wss://` in this context (5.2) or realtime is dead via mixed-content blocking.
- **SW update & navigation pitfalls.** `registerWhenStable:30000` avoids fighting app boot. `SwUpdate` banner (1.12) applies on idle/next-nav — never a forced reload over a dirty form — and subscribes `unrecoverable` for self-recovery with cache clear. `navigationUrls` exclude `/api/**`, `/ws/**`, `/git/**`, `/webhooks/**` so the SPA fallback never hijacks git smart-HTTP or webhook endpoints (1.2). Conservative update-check cadence (focus/6h), not per-visibility-change, to avoid hammering the backend on mobile foreground churn.
- **WebSocket ↔ SW interaction.** SWs cannot intercept WS upgrades (browser passes them through), but `/ws/**` and `/api/**` must be explicitly network-only / absent from cache rules to avoid debugging confusion and accidental caching of dynamic responses.

## 5. Testing strategy

Each phase has automated/manual gates; a final real-device matrix anchors release.

**Standing regression gates (run every phase):**
- Karma unit suite `npm run test:ci` — 13 specs green.
- Go `go test ./... -race` — all pass (WS auth, disk-stats API).
- Desktop 1440px manual smoke: sidebar always visible, all columns, right-click menus, mouse pan/wheel zoom, centred modals.

**Per-phase gates:**

- **Phase 1:**
  - **Installability gate (NOT the Lighthouse PWA category — removed in LH 12).** Pin lhci/Lighthouse to a version that still emits the PWA category **or** (preferred) replace it with explicit checks wired into CI: manifest validity via a manifest-lint step; SW registration + `start_url`-offline asserted in the MCP/Playwright sweep via `evaluate_script` (`navigator.serviceWorker.controller`, `matchMedia('(display-mode: standalone)')`, `getInstalledRelatedApps`). Document the chosen approach/LH version in `.lighthouserc.json`.
  - **Performance Lighthouse CI** (`lhci autorun`) still wired into `ci.yml` as a persistent gate on perf/a11y/best-practices: Perf ≥80 (Moto G4/4G: FCP<2.5s, LCP<3.0s, TBT<200ms, CLS<0.1), A11y ≥90, Best-Practices ≥90.
  - Offline cold-launch shell (Chrome offline reload + iOS airplane relaunch) with graceful empty state; **logged-out + expired-token** offline cold launch lands on login (no spinner), `init()` resolves `ready=true` when both `/status` and `/me` network-fail.
  - **Token survives offline relaunch**; 401-vs-status-0 disambiguation.
  - SW cache audit (no `/ws`,`/api`; woff2 only; <1MB precache); `navigationUrls` exclude git/webhooks.
  - Maskable-icon adaptive render (maskable.app); icon regression sweep all 23 routes incl. dynamic `eventIcon`/`actIcon`/`fileMeta`/`role.icon`; no whole-document re-scan (verify via Performance trace on Containers); bundle within tightened budget (validated against a real prod build before setting the ceiling).
- **Phase 2:** long-press opens correct menu on all 11 surfaces (iOS+Android), tap-outside dismiss, submenu tap-open, iOS native menu suppressed; topology pan/pinch/select/highlight on touch, no passive warnings; metrics touch tooltips + page still scrolls; events mute tappable; Users/Roles tap-outside close; desktop right-click regression on all 11.
- **Phase 3:** bottom tabs route on real iPhone standalone + clear home indicator; safe-area no notch clipping in **portrait AND landscape** (Dynamic Island, left/right insets); standalone status-bar colour/style correct in **both dark and light** themes; back closes drawer/detail; no pull-to-refresh standalone; route transition ≤200ms no double-render; tap-highlight suppressed with focus rings intact; scroll restore on back.
- **Phase 4:** Containers/Events cards at 390px no h-scroll; CDK virtual-scroll correct with 100+ items + `overscroll-behavior:contain`; topology list ≤600px (switches live on rotation/iPad split-view) + full-screen detail; bottom-sheet slide-up + drag handle + backdrop dismiss; footer visible above keyboard via `visualViewport` on iOS 16; **no iOS input zoom** across every modal/form; numeric/email/url keyboards; validation errors visible; bulk-select on touch; admin role modal usable; tap targets ≥44px; remaining h-scroll tables show scroll shadow on real iOS.
- **Phase 5:** allstats reconnect ≤15s after DevTools socket kill; **`wss://` confirmed + zero mixed-content errors in HTTPS standalone**; no WS frames/timers while hidden (Performance timeline); airplane→on reconnect <500ms + counts refresh; offline banner appears/clears; SW never caches WS upgrades.
- **Phase 6:** reduced-motion emulation removes animation, no layout shift; dark+light at 390/1440; swipe-dismiss/pull-to-refresh don't fight scroll or re-introduce standalone blank-bounce; axe 0 critical/serious (aria-labels, focus rings, contrast of `--fg-subtle`).

**Chrome DevTools MCP emulation sweep (P1, after Phase 3):** emulate iPhone 12 Pro (390×844 @3x) + Pixel 5 (393×851) + iPad Air (768×1024). For all 23 routes: `navigate_page`→`take_screenshot`; assert no horizontal overflow (`scrollWidth ≤ viewport`), sidebar collapsed + bottom-tab/hamburger present, tables→cards (or h-scroll where intended), detail panels full-screen overlay, modals fit, charts 100% width, topology controls reachable. Log pass/fail per route×device. `lighthouse_audit` for Perf on key routes; installability via `evaluate_script`.

**Playwright e2e (P1):** `@playwright/test`, three projects (desktop 1280×800, iPhone 390×844, Pixel 393×851). Smoke: dashboard, containers (hamburger+overlay), logs (stacked), topology (canvas+zoom), metrics (2-up). `npm run e2e` in CI against a **mocked backend** (route interception — real Docker isn't available on `ubuntu-latest`; plan this early or it blocks the gate).

**Final real-device matrix (P2, pre-release):**
- **A) iOS Safari 16.4+** (iPhone 14/15, real hardware — Simulator under-reproduces SW): Share→Add-to-Home-Screen, standalone launch, splash, safe-area in **portrait and landscape** (Dynamic Island left/right insets), long-press menus, pinch topology, WS reconnect after 30s background, `wss://` (no mixed-content), `navigator.serviceWorker.controller` set, offline relaunch keeps session, light-theme status bar legible.
- **B) Android Chrome 120+** (Pixel/Samsung): install prompt + screenshots in dialog, splash, standalone, touch targets, long-press, install banner hidden once installed.
- **C) iPad Safari 768px** (820px breakpoint → off-canvas; hamburger present; **landscape + Split View / Slide Over** narrow widths switch nav/cards live).
- **D) Desktop Chrome/Firefox/Safari** 1440px: right-click menus, Ctrl+K palette, full sidebar.

## 6. Risks & open questions

- **`auth.init()` evicts token offline (1.8)** — every offline relaunch logs the user out. **Blocks all PWA install testing** — land first.
- **`streamAllStats()` completes permanently on close (5.1)** — a live data-loss bug TODAY (containers/metrics/topology go dark). Fix early; not strictly PWA-gated.
- **WS scheme must be `wss://` in the install context (5.2)** — if hardcoded `ws://`, every HTTPS install has dead realtime via mixed-content blocking. Verify before declaring Phase 1 done.
- **Lighthouse dropped the PWA category (LH 12)** — the obvious "assert PWA 100" gate is a false-green; use pinned LH 11.x or explicit installability checks (Section 5).
- **`icon.component.ts` global re-scan (1.6)** — without per-element rendering, tree-shaking's win is partly eaten by an O(n²) document re-scan on icon-dense pages.
- **CDK virtual-scroll itemSize=42 vs card layout (4.2)** — highest-risk visual bug; needs `BreakpointObserver` conditional template, not just CSS; AutoSize strategy explicitly avoided (extra package surface).
- **Inline `grid-template-columns` beats `!important` (4.21)** — must move to classes; CSS-only override impossible.
- **iOS keyboard handling (4.20)** — iOS doesn't fire window `resize` on keyboard; dvh/`env(keyboard-inset-height)` alone are unreliable on iOS 15-16; `visualViewport` is the primary mechanism.
- **iOS passive-listener `preventDefault()` ignored (2.4/2.5)** — topology pinch + new metrics touch need manual `{passive:false}` listeners.
- **SwUpdate forced reload (1.12)** — a non-dismissable reload over a dirty bottom-sheet form loses input; must defer to idle/next-nav and handle `unrecoverable`.
- **Status-bar style vs theme (3.3)** — `black-translucent` makes light-theme status-bar glyphs invisible; switch style at runtime with theme.
- **iOS ~7-day storage eviction** — unavoidable; mitigate UX only (5.11).
- **820px breakpoint shared** by sidebar-collapse + mobile tables — cards at 820px also affect tablets; **open question: split card breakpoint to 600px** to keep tables on large phones/small tablets while keeping sidebar-collapse at 820px?
- **"More" tab UX (3.1)** — left off-canvas drawer vs iOS-style bottom sheet? Avoid drawer-and-sheet confusion.
- **Standalone install-nag (1.13/1.14)** — without the `PwaModeService.isStandalone` guard, installed users see a permanent "install me" banner.
- **Hiding statusbar on phone (3.1)** removes engine-connectivity indicator — must resurface (topbar/drawer + RealtimeService `connected` signal, 5.8).
- **`history.pushState` drawer back-handling (3.8)** fragile on open-navigate-back-back sequences — test thoroughly.
- **Playwright needs mocked backend** — Docker unavailable on CI runners; plan interception early or it blocks the e2e gate.
- **maskable icon safe-zone** — verify on maskable.app before deploy or content clips on Android.
- **`@angular/material` unused dep (1.15)** — tree-shaken today; confirm and consider removing while validating the new `initial` budget against a real prod build.
- **Pull-to-refresh re-introducing standalone bounce (6.1)** — scope to a top sentinel, don't relax `overscroll-behavior` on the whole scroller.

## 7. Effort roll-up

Effort key: S≈0.5–1 day, M≈1.5–3 days.

| Phase | P0 items | P1 items | P2 items | S / M | Rough effort |
|---|---|---|---|---|---|
|1 — PWA core| 9 (incl. 1.7 stopgap) | 7 | 2 | 15S / 3M | ~10–12 d |
|2 — Touch interactions| 3 | 4 | 2 | 8S / 1M | ~5–6 d |
|3 — Navigation native-feel| 3 | 4 | 3 | 8S / 2M | ~7–8 d |
|4 — Lists→cards + forms→sheets| 9 | 14 | 5 | 22S / 6M | ~20–24 d |
|5 — Offline/realtime/perf| 3 | 6 | 2 | 9S / 2M | ~6–7 d |
|6 — Polish| 0 | 1 | 3 | 2S / 2M | ~4–5 d |
| **Total** | **27** | **36** | **17** | **~64S / 16M** | **~52–62 dev-days** |

Testing infrastructure (installability/Lighthouse CI, Playwright, MCP sweep, device matrix) adds **~6–9 dev-days** spread across phases (front-loaded in Phase 1).

**⭐ Minimum installable milestone = end of Phase 1** (~10–12 dev-days; P0 items 1.1–1.9 + 1.11, plus the auth fixes 1.8/1.9 and the SW/manifest/icon/Lucide core). At that point Dockyard installs on Android + iOS, boots offline as a shell (logged-in and logged-out paths both graceful), keeps users signed in across offline relaunches, renders the Lucide subset without the document re-scan, and passes the explicit installability checks (manifest valid, SW registered+activated, `start_url` offline). Phases 2–6 progressively deliver native feel; **Phases 2–3 (touch + navigation, ~12–14 days)** are the next-highest-value increment for a phone-first experience, and **Phase 4 is the largest single investment** (cards + sheets across the whole app).
