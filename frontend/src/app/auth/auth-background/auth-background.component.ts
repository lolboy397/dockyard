import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild } from '@angular/core';

/* =========================================================================
   Dockyard — animated background · "orchestration grid"
   1-2-1 port of system_design/app-auth/background.jsx.

   A structured scheduler, not floating cargo. Typed services boot up on a
   grid of slots, pulse data to neighbours, then shut down — new ones spin up
   to replace them, so the cluster keeps breathing. Each type has its own
   status-palette colour + Lucide icon (API, SQL, Cache, Broker, Gateway).
   Grid is masked by a central keep-out so the mesh frames the card.
   Cyan structure lines · type-coloured pulses. Honors reduced-motion.
   API: window.DockyardMesh { setSource(x,y|null), burst(x,y,n) }
   ========================================================================= */
@Component({
  selector: 'dy-auth-background',
  standalone: true,
  styleUrls: ['./auth-background.component.scss'],
  templateUrl: './auth-background.component.html',
})
export class AuthBackgroundComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  private cleanup?: () => void;

  constructor(private zone: NgZone) {}

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => { this.cleanup = this.run(this.canvasRef.nativeElement); });
  }

  ngOnDestroy(): void { this.cleanup?.(); }

  private run(canvas: HTMLCanvasElement): () => void {
    const ctx = canvas.getContext('2d')!;
    const CY = '34, 211, 238';
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const TYPES = [
      { id: 'api',      label: 'API',      icon: 'webhook',      rgb: '34, 211, 238' },
      { id: 'database', label: 'DATABASE', icon: 'database',     rgb: '96, 165, 250' },
      { id: 'frontend', label: 'FRONTEND', icon: 'app-window',   rgb: '52, 211, 153' },
      { id: 'cache',    label: 'CACHE',    icon: 'zap',          rgb: '251, 191, 36' },
      { id: 'worker',   label: 'WORKER',   icon: 'cog',          rgb: '148, 163, 184' },
      { id: 'queue',    label: 'QUEUE',    icon: 'list-ordered', rgb: '167, 139, 250' },
      { id: 'auth',     label: 'AUTH',     icon: 'key-round',    rgb: '244, 114, 182' },
      { id: 'proxy',    label: 'PROXY',    icon: 'route',        rgb: '251, 146, 60' },
    ];
    const icons: Record<string, any> = {};

    let W = 0, H = 0, dpr = 1, raf = 0, tick = 0, flash = 0, focusBox: any = null;
    let cells: any[] = [], boxes: any[] = [], pulses: any[] = [], sp = 150;

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const cl01 = (t: number) => t < 0 ? 0 : t > 1 ? 1 : t;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const easeOutBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
    const easeInOut = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    function roundRect(x: number, y: number, w: number, h: number, r: number) {
      if ((ctx as any).roundRect) { ctx.beginPath(); (ctx as any).roundRect(x, y, w, h, r); return; }
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }

    // central keep-out so the grid frames the card
    function keepout() { return { cx: W / 2, cy: H / 2, rx: W * 0.27, ry: H * 0.32 }; }
    function inKeepout(x: number, y: number) { const k = keepout(); const dx = (x - k.cx) / k.rx, dy = (y - k.cy) / k.ry; return dx * dx + dy * dy < 1; }

    function buildIcons() {
      if (!(window as any).lucide) return;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
      wrap.innerHTML = TYPES.map(t => `<span data-k="${t.id}"><i data-lucide="${t.icon}"></i></span>`).join('');
      document.body.appendChild(wrap);
      try { (window as any).lucide.createIcons({ nameAttr: 'data-lucide' }); } catch (e) {}
      TYPES.forEach(t => {
        const svg = wrap.querySelector(`[data-k="${t.id}"] svg`);
        icons[t.id] = svg ? parseIcon(svg) : null;
      });
      document.body.removeChild(wrap);
    }

    // Parse a Lucide SVG (24x24 viewBox) into primitive draw-ops once, so we can
    // render the icon as crisp canvas vectors every frame (no async image loads).
    function parseIcon(svg: Element) {
      const ops: any[] = [];
      svg.querySelectorAll('path,circle,line,polyline,polygon,rect,ellipse').forEach(el => {
        const g = el.tagName.toLowerCase(), n = (k: string) => parseFloat(el.getAttribute(k) || '') || 0;
        if (g === 'path') ops.push({ g, d: el.getAttribute('d') });
        else if (g === 'circle') ops.push({ g, cx: n('cx'), cy: n('cy'), r: n('r') });
        else if (g === 'ellipse') ops.push({ g, cx: n('cx'), cy: n('cy'), rx: n('rx'), ry: n('ry') });
        else if (g === 'line') ops.push({ g, x1: n('x1'), y1: n('y1'), x2: n('x2'), y2: n('y2') });
        else if (g === 'rect') ops.push({ g, x: n('x'), y: n('y'), w: n('width'), h: n('height'), rx: n('rx') });
        else if (g === 'polyline' || g === 'polygon') ops.push({ g, pts: (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number) });
      });
      return ops;
    }

    function drawIcon(ops: any[], cx: number, cy: number, half: number, alpha: number, rgb: string) {
      if (!ops || !ops.length) return false;
      const s = (2 * half) / 24;
      ctx.save();
      ctx.translate(cx - half, cy - half);
      ctx.scale(s, s);
      ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
      ctx.lineWidth = Math.max(1.3, half * 0.085) / s;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const op of ops) {
        if (op.g === 'path') { ctx.stroke(new Path2D(op.d)); continue; }
        ctx.beginPath();
        if (op.g === 'circle') ctx.arc(op.cx, op.cy, op.r, 0, 6.2832);
        else if (op.g === 'ellipse') ctx.ellipse(op.cx, op.cy, op.rx, op.ry, 0, 0, 6.2832);
        else if (op.g === 'line') { ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); }
        else if (op.g === 'rect') {
          const r = Math.min(op.rx || 0, op.w / 2, op.h / 2);
          if ((ctx as any).roundRect) (ctx as any).roundRect(op.x, op.y, op.w, op.h, r); else ctx.rect(op.x, op.y, op.w, op.h);
        } else if (op.g === 'polyline' || op.g === 'polygon') {
          const p = op.pts; for (let i = 0; i < p.length; i += 2) { i ? ctx.lineTo(p[i], p[i + 1]) : ctx.moveTo(p[i], p[i + 1]); }
          if (op.g === 'polygon') ctx.closePath();
        }
        ctx.stroke();
      }
      ctx.restore();
      return true;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildGrid();
    }

    function buildGrid() {
      sp = Math.max(120, Math.min(165, W / 8.5));
      const cols = Math.max(2, Math.floor((W - sp * 0.4) / sp));
      const rows = Math.max(2, Math.floor((H - sp * 0.4) / sp));
      const offX = (W - (cols - 1) * sp) / 2, offY = (H - (rows - 1) * sp) / 2;
      cells = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = offX + c * sp, y = offY + r * sp;
        if (!inKeepout(x, y) && x > 8 && x < W - 8 && y > 8 && y < H - 8) cells.push({ x, y, busy: false });
      }
      boxes = []; pulses = []; focusBox = null;
      // initial population — already "live"
      const target = popTarget();
      for (let i = 0; i < target; i++) spawnBox(true);
      // seed a couple of in-flight pulses
      for (let i = 0; i < 2; i++) emitFrom(boxes[(Math.random() * boxes.length) | 0]);
      pulses.forEach(p => { p.t = rnd(0.2, 0.7); });
    }

    function popTarget() { return Math.min(cells.length, Math.max(4, Math.round(cells.length * 0.32))); }
    function activeCount() { return boxes.filter(b => b.state !== 'down').length; }
    function freeCell() {
      const free = cells.filter(c => !c.busy);
      return free.length ? free[(Math.random() * free.length) | 0] : null;
    }

    // Pick a type that differs from nearby live containers and balances the overall
    // mix — avoids clusters of the same service (e.g. three frontends pinging).
    function pickType(cell: any) {
      const counts: Record<string, number> = {}; TYPES.forEach(t => { counts[t.id] = 0; });
      const nearIds = new Set<string>();
      for (const b of boxes) {
        if (b.state === 'down') continue;
        counts[b.type.id] = (counts[b.type.id] || 0) + 1;
        if (cell && Math.hypot(b.x - cell.x, b.y - cell.y) < sp * 2.4) nearIds.add(b.type.id);
      }
      let pool = TYPES.filter(t => !nearIds.has(t.id));
      if (!pool.length) pool = TYPES.slice();
      const min = Math.min(...pool.map(t => counts[t.id]));
      const least = pool.filter(t => counts[t.id] === min);
      return least[(Math.random() * least.length) | 0];
    }

    function spawnBox(initial: boolean) {
      const cell = freeCell(); if (!cell) return null;
      cell.busy = true;
      const type = pickType(cell);
      const b = {
        cell, type, x: cell.x, y: cell.y, size: Math.max(9, Math.round(sp * 0.08)),
        state: initial ? 'live' : 'boot', anim: initial ? 1 : 0,
        age: initial ? rnd(0, 300) : 0, life: rnd(1100, 2200),
        glow: 0, label: initial ? rnd(0.4, 1) : 0, labelHold: initial ? rnd(60, 340) : 0, nextPulse: tick + (initial ? rnd(60, 300) : rnd(150, 320)),
      };
      boxes.push(b); return b;
    }
    function hasActivePulse(b: any) { for (const p of pulses) if (p.from === b || p.to === b) return true; return false; }
    function shutdown(b: any) { if (b && b.state === 'live' && !hasActivePulse(b)) b.state = 'down'; }

    function liveNeighbours(b: any) {
      const out: any[] = [];
      for (const o of boxes) {
        if (o === b || o.state !== 'live') continue;
        if (Math.hypot(o.x - b.x, o.y - b.y) < sp * 1.6) out.push(o);
      }
      return out;
    }
    function emitFrom(b: any, rgb?: string) {
      if (!b || pulses.length > 8) return;
      if (pulses.some(p => p.from === b)) return;   // at most one outgoing pulse per container
      const nb = liveNeighbours(b);
      if (!nb.length) return;
      const to = nb[(Math.random() * nb.length) | 0];
      pulses.push({ from: b, to, t: 0, speed: rnd(0.0023, 0.0032), rgb: rgb || b.type.rgb });
      b.glow = Math.max(b.glow, 0.85); b.labelHold = Math.max(b.labelHold, 320);
    }

    function drawBox(b: any) {
      const t = b.type;
      let a, sc;
      if (b.state === 'boot') { const p = cl01(b.anim); a = cl01(p * 1.5); sc = 0.42 + 0.58 * easeOutBack(p); }
      else if (b.state === 'down') { const p = cl01(b.anim); a = easeOut(p) * 0.85; sc = 0.9 + 0.1 * p; }
      else { a = 1; sc = 1; }
      if (a <= 0.01) return;
      const S = b.size;
      ctx.save();
      ctx.translate(b.x, b.y); ctx.scale(sc, sc);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.rect(-S, -S, S * 2, S * 2);
      // opaque backing so traveling dots tuck BEHIND the tile
      ctx.fillStyle = `rgba(8, 11, 18, ${a * 0.93})`;
      ctx.fill();
      if (b.glow > 0.02) { ctx.shadowColor = `rgba(${t.rgb}, ${0.3 * b.glow})`; ctx.shadowBlur = 10 * b.glow; }
      ctx.fillStyle = `rgba(${t.rgb}, ${a * (0.04 + b.glow * 0.08)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${t.rgb}, ${a * (0.2 + b.glow * 0.32)})`;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // icon — centered in the small square with a ~3.5px inset gap to the border
      const ir = Math.max(4, S - 3.5), iA = a * (0.52 + b.glow * 0.2);
      if (!drawIcon(icons[t.id], 0, 0, ir, iA, t.rgb)) {
        ctx.fillStyle = `rgba(${t.rgb}, ${iA * 0.8})`;
        ctx.fillRect(-2, -2, 4, 4);
      }
      ctx.restore();

      // name — below the square (fades together with the tile via a)
      if (a > 0.04) {
        ctx.font = "600 8px 'Geist Mono', ui-monospace, monospace";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(${t.rgb}, ${a * (0.32 + b.glow * 0.3)})`;
        ctx.fillText(t.label, b.x, b.y + S * sc + 9);
        ctx.textBaseline = 'alphabetic';
      }

      // boot ring — a square outline that expands and fades as the card slots in (boot only;
      // despawns are a clean fade into the background, no ring)
      if (b.state === 'boot') {
        const p = cl01(b.anim);
        ctx.strokeStyle = `rgba(${t.rgb}, ${0.28 * (1 - p)})`;
        ctx.lineWidth = 1.2;
        const rr = S * (0.95 + p * 0.7);
        ctx.strokeRect(b.x - rr, b.y - rr, rr * 2, rr * 2);
      }
    }

    function frame() {
      tick++; flash *= 0.92;
      ctx.clearRect(0, 0, W, H);

      // empty slot markers — the grid structure
      ctx.fillStyle = `rgba(${CY}, 0.05)`;
      for (const c of cells) if (!c.busy) ctx.fillRect(c.x - 1, c.y - 1, 2, 2);

      // structure links between live neighbours (neutral cyan)
      const live = boxes.filter(b => b.state === 'live');
      ctx.lineWidth = 1;
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < sp * 1.6) {
          ctx.strokeStyle = `rgba(${CY}, ${(1 - d / (sp * 1.6)) * 0.05 * (1 + flash)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      // lifecycle: churn population
      if (!reduced) {
        if (tick % 44 === 0 && activeCount() < popTarget() && Math.random() < 0.7) spawnBox(false);
        if (tick % 300 === 0 && activeCount() > Math.max(4, popTarget() - 3) && Math.random() < 0.6) {
          const liveOld = boxes.filter(b => b.state === 'live' && b.age > 360 && !hasActivePulse(b)).sort((a, b) => b.age - a.age);
          if (liveOld.length) shutdown(liveOld[(Math.random() * Math.min(3, liveOld.length)) | 0]);
        }
      }

      // update boxes
      for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i];
        b.glow *= 0.965;
        if (b.labelHold > 0) b.labelHold--;
        b.label += ((b.labelHold > 0 ? 1 : 0) - b.label) * 0.045;
        if (b.state === 'boot') { b.anim += 1 / 95; if (b.anim >= 1) { b.anim = 1; b.state = 'live'; b.labelHold = 260; } }
        else if (b.state === 'live') {
          b.age++;
          // stop emitting once expiring so it can drain and despawn; calmer cadence
          if (!reduced && b.age <= b.life && tick >= b.nextPulse) { emitFrom(b); b.nextPulse = tick + rnd(560, 1040); }
          if (!reduced && b.age > b.life && !hasActivePulse(b)) b.state = 'down';
        } else if (b.state === 'down') {
          b.anim -= 1 / 58;
          if (b.anim <= 0) { b.cell.busy = false; boxes.splice(i, 1); continue; }
        }
      }

      // focused service keeps a gentle heartbeat
      if (!reduced && focusBox && focusBox.state === 'live') {
        focusBox.glow = Math.max(focusBox.glow, 0.5);
        if (tick % 70 === 0) emitFrom(focusBox);
      }

      // pulses
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        if (p.from.state === 'down' || p.to.state === 'down') { pulses.splice(i, 1); continue; }
        p.t += p.speed;
        const e = easeInOut(Math.min(1, p.t));
        const x = p.from.x + (p.to.x - p.from.x) * e, y = p.from.y + (p.to.y - p.from.y) * e;
        // active link highlight (kept very subtle)
        ctx.strokeStyle = `rgba(${p.rgb}, 0.05)`;
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(p.to.x, p.to.y); ctx.stroke();
        // trail — longer, softer comet for a smooth read
        for (let s = 1; s <= 7; s++) {
          const te = easeInOut(Math.max(0, Math.min(1, p.t - s * 0.035)));
          const tx = p.from.x + (p.to.x - p.from.x) * te, ty = p.from.y + (p.to.y - p.from.y) * te;
          ctx.fillStyle = `rgba(${p.rgb}, ${0.085 * (1 - s / 8)})`;
          ctx.beginPath(); ctx.arc(tx, ty, 1.6 - s * 0.16, 0, 6.2832); ctx.fill();
        }
        ctx.save();
        ctx.shadowColor = `rgba(${p.rgb}, 0.45)`; ctx.shadowBlur = 4;
        ctx.fillStyle = `rgba(${p.rgb}, 0.6)`;
        ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 6.2832); ctx.fill();
        ctx.restore();
        if (p.t >= 1) { p.to.glow = Math.max(p.to.glow, 0.5); p.to.labelHold = Math.max(p.to.labelHold, 320); pulses.splice(i, 1); }
      }

      // boxes on top
      for (const b of boxes) drawBox(b);

      if (!reduced) raf = requestAnimationFrame(frame);
    }

    function nearestLive(x: number, y: number) {
      let best = null, bd = Infinity;
      for (const b of boxes) {
        if (b.state === 'down') continue;
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < bd) { bd = d; best = b; }
      }
      return best;
    }

    const api = {
      setSource(x: number | null, y?: number) {
        if (x == null) { focusBox = null; return; }
        let b: any = nearestLive(x, y!);
        // if the nearest slot near the field is empty, boot one there
        if (!b || Math.hypot(b.x - x, b.y - y!) > sp) {
          const free = cells.filter(c => !c.busy).sort((p, q) => Math.hypot(p.x - x, p.y - y!) - Math.hypot(q.x - x, q.y - y!))[0];
          if (free) { const nb = spawnBoxAt(free); if (nb) b = nb; }
        }
        focusBox = b || focusBox;
        if (focusBox) { focusBox.glow = 1; emitFrom(focusBox); }
      },
      burst(x: number, y: number, n = 6) {
        const c = nearestLive(x, y); if (!c) return;
        c.glow = 1.4; flash = 1;
        // one pulse each from a few nearby containers (respects the per-container limit)
        const near = boxes.filter(b => b.state === 'live' && Math.hypot(b.x - x, b.y - y) < sp * 2.2)
          .sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y)).slice(0, n);
        near.forEach(b => emitFrom(b));
      },
    };
    function spawnBoxAt(cell: any) {
      if (!cell || cell.busy) return null;
      cell.busy = true;
      const type = pickType(cell);
      const b = { cell, type, x: cell.x, y: cell.y, size: Math.max(9, Math.round(sp * 0.08)), state: 'boot', anim: 0, age: 0, life: rnd(1100, 2200), glow: 1, label: 0, labelHold: 240, nextPulse: tick + rnd(40, 120) };
      boxes.push(b); return b;
    }
    (window as any).DockyardMesh = api;

    buildIcons();
    resize();
    window.addEventListener('resize', resize);
    frame();   // synchronous first frame (rAF is paused in unfocused tabs)

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      if ((window as any).DockyardMesh === api) delete (window as any).DockyardMesh;
    };
  }
}
