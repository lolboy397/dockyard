import {
  Component, ElementRef, ViewChild, OnInit, OnDestroy, effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../icon/icon.component';
import { ContextMenuService, OpenContextMenu } from '../../../services/context-menu.service';
import { MenuListComponent } from './menu-list.component';

/**
 * The single, app-wide context-menu host. Mount once near the app root
 * (see app.component.html) — like the toast container / command palette.
 *
 * 1:1 port of the design-system `ContextMenu.jsx`: a fixed backdrop layer, a
 * raised menu surface that measures itself and flips to stay inside the
 * viewport, an optional target-identity header, and dismissal on
 * escape / scroll / resize / outside-click.
 */
@Component({
  selector: 'dy-context-menu',
  standalone: true,
  imports: [CommonModule, IconComponent, MenuListComponent],
  template: `
    @if (svc.menu(); as m) {
      <div
        class="cm-layer"
        (mousedown)="svc.close()"
        (contextmenu)="onLayerContext($event)"
      >
        <div
          #cm
          class="cm"
          [style.left.px]="left"
          [style.top.px]="top"
          [style.--cm-origin]="origin"
          [style.visibility]="ready ? 'visible' : 'hidden'"
          (mousedown)="$event.stopPropagation()"
          (contextmenu)="onMenuContext($event)"
        >
          @if (m.header; as h) {
            <div class="cm-header">
              <span class="cm-h-ic"><dy-icon [name]="h.icon || 'box'" [size]="14"></dy-icon></span>
              <span class="cm-h-main">
                <span class="cm-h-name">{{ h.name }}</span>
                @if (h.meta) { <span class="cm-h-meta">{{ h.meta }}</span> }
              </span>
            </div>
          }
          <dy-menu-list [items]="m.items" [depth]="0"></dy-menu-list>
        </div>
      </div>
    }
  `,
})
export class ContextMenuComponent implements OnInit, OnDestroy {
  @ViewChild('cm') cmEl?: ElementRef<HTMLElement>;

  left = 0;
  top = 0;
  origin = 'top left';
  ready = false;

  private static readonly MARGIN = 8;
  private lastRef: OpenContextMenu | null = null;
  private escHandler = (e: KeyboardEvent) => {
    if (!this.svc.menu()) return;
    if (e.key === 'Escape') { e.stopPropagation(); this.svc.close(); }
  };
  private dismiss = () => { if (this.svc.menu()) this.svc.close(); };

  constructor(public svc: ContextMenuService) {
    // Whenever a new menu opens, anchor it at the pointer, then measure on the
    // next frame and flip it into the viewport (mirrors the mockup's layout effect).
    effect(() => {
      const m = this.svc.menu();
      if (!m) { this.lastRef = null; return; }
      if (m === this.lastRef) return;
      this.lastRef = m;
      this.left = m.x;
      this.top = m.y;
      this.origin = 'top left';
      this.ready = false;
      requestAnimationFrame(() => this.reposition(m));
    });
  }

  ngOnInit(): void {
    // Capture-phase escape so the menu swallows it before app-level handlers
    // (e.g. the command palette / modals) react. Scroll + resize dismiss too.
    document.addEventListener('keydown', this.escHandler, true);
    window.addEventListener('resize', this.dismiss);
    window.addEventListener('wheel', this.dismiss, { passive: true });
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.escHandler, true);
    window.removeEventListener('resize', this.dismiss);
    window.removeEventListener('wheel', this.dismiss);
  }

  onLayerContext(e: MouseEvent): void { e.preventDefault(); this.svc.close(); }
  onMenuContext(e: MouseEvent): void { e.preventDefault(); e.stopPropagation(); }

  private reposition(m: OpenContextMenu): void {
    const el = this.cmEl?.nativeElement;
    if (!el || this.svc.menu() !== m) return;
    const { width, height } = el.getBoundingClientRect();
    const MARGIN = ContextMenuComponent.MARGIN;
    let left = m.x, top = m.y, ox = 'top', oy = 'left';
    if (left + width > window.innerWidth - MARGIN) { left = m.x - width; oy = 'right'; }
    if (left < MARGIN) left = MARGIN;
    if (top + height > window.innerHeight - MARGIN) { top = Math.max(MARGIN, m.y - height); ox = 'bottom'; }
    if (top < MARGIN) top = MARGIN;
    this.left = left;
    this.top = top;
    this.origin = `${ox} ${oy}`;
    this.ready = true;
  }
}
