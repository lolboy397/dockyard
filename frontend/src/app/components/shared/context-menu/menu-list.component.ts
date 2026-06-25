import {
  Component, Input, ElementRef, ViewChild, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../icon/icon.component';
import { ContextMenuService, ContextMenuItem } from '../../../services/context-menu.service';

/**
 * A single flat menu list — also used recursively for submenus.
 * 1:1 port of the `MenuList` component in the design-system ContextMenu.jsx:
 * hover-to-open submenus (with a small close delay), keyboard navigation, and
 * viewport-aware submenu placement.
 */
@Component({
  selector: 'dy-menu-list',
  standalone: true,
  imports: [CommonModule, IconComponent, MenuListComponent],
  template: `
    <div class="cm-inner" #inner>
      @for (it of items; track $index) {
        @if (it.type === 'separator') {
          <div class="cm-sep"></div>
        } @else if (it.type === 'label') {
          <div class="cm-label">{{ it.label }}</div>
        } @else {
          <div
            [attr.data-mi]="$index"
            class="cm-item"
            [class.danger]="it.danger"
            [class.accent]="it.accent"
            [class.disabled]="it.disabled"
            [class.active]="active === $index"
            (mouseenter)="hoverEnter($index, it)"
            (mouseleave)="hoverLeave(it)"
            (click)="onClick($event, it)"
          >
            @if (it.icon) {
              <span class="cm-ic"><dy-icon [name]="it.icon" [size]="15"></dy-icon></span>
            }
            <span class="cm-text">{{ it.label }}</span>

            @if (it.items) {
              <span class="cm-chev"><dy-icon name="chevron-right" [size]="14"></dy-icon></span>
            } @else if (it.checked !== undefined) {
              <span class="cm-check" [class.off]="!it.checked"><dy-icon name="check" [size]="14"></dy-icon></span>
            } @else if (it.shortcut) {
              <span class="cm-k">{{ it.shortcut }}</span>
            }

            @if (it.items && openSub === $index && subPos) {
              <div
                class="cm-sub"
                [style.left.px]="subPos.left"
                [style.top.px]="subPos.top"
                [style.transformOrigin]="subPos.originX + ' top'"
                (click)="$event.stopPropagation()"
                (mouseenter)="clearCloseTimer()"
              >
                <dy-menu-list [items]="it.items" [depth]="depth + 1"></dy-menu-list>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class MenuListComponent {
  @Input() items: ContextMenuItem[] = [];
  @Input() depth = 0;

  @ViewChild('inner') inner?: ElementRef<HTMLElement>;

  active = -1;
  openSub = -1;
  subPos: { left: number; top: number; originX: 'left' | 'right' } | null = null;

  private closeTimer: any = null;

  private static readonly MARGIN = 8;     // viewport keep-out
  private static readonly SUB_W = 196;
  private static readonly SUB_H = 240;

  constructor(private host: ElementRef<HTMLElement>, private svc: ContextMenuService) {}

  /** Indices that are focusable (skip separators / labels / disabled). */
  private get selectable(): number[] {
    return this.items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !it.type && !it.disabled)
      .map(({ i }) => i);
  }

  private run(it: ContextMenuItem): void {
    if (it.disabled || it.type) return;
    if (it.items) return;            // submenu parent — handled by hover / arrow
    if (it.onSelect) it.onSelect();
    this.svc.close();
  }

  onClick(e: Event, it: ContextMenuItem): void {
    e.stopPropagation();
    // Submenu parents open on tap/click — hover-to-open isn't available on touch.
    if (it.items && !it.disabled) {
      const idx = this.items.indexOf(it);
      if (this.openSub === idx) { this.openSub = -1; }
      else { this.active = idx; this.positionSub(idx); }
      return;
    }
    this.run(it);
  }

  private positionSub(idx: number): void {
    const inner = this.inner?.nativeElement;
    if (!inner) return;
    const row = inner.querySelector(`:scope > [data-mi="${idx}"]`) as HTMLElement | null;
    if (!row) return;
    const r = row.getBoundingClientRect();
    const MARGIN = MenuListComponent.MARGIN;
    const SUB_W = MenuListComponent.SUB_W;
    const SUB_H = MenuListComponent.SUB_H;
    let left = r.right - 4;
    let originX: 'left' | 'right' = 'left';
    if (left + SUB_W > window.innerWidth - MARGIN) {
      left = r.left - SUB_W + 4;
      originX = 'right';
    }
    let top = r.top - 5;
    if (top + SUB_H > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, window.innerHeight - SUB_H - MARGIN);
    }
    this.subPos = { left, top, originX };
    this.openSub = idx;
  }

  hoverEnter(idx: number, it: ContextMenuItem): void {
    this.clearCloseTimer();
    this.active = idx;
    if (it.items) this.positionSub(idx);
    else this.openSub = -1;
  }

  hoverLeave(it: ContextMenuItem): void {
    if (it.items) {
      this.closeTimer = setTimeout(() => (this.openSub = -1), 120);
    }
  }

  clearCloseTimer(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }

  // Keyboard navigation within this list. When a submenu is open we defer to it,
  // so only the deepest visible list responds to the arrow keys / Enter.
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (this.openSub !== -1) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const sel = this.selectable;
      if (!sel.length) return;
      const pos = sel.indexOf(this.active);
      const next = sel[(pos + dir + sel.length) % sel.length] ?? sel[0];
      this.active = next;
      this.openSub = -1;
    } else if (e.key === 'ArrowRight') {
      const it = this.items[this.active];
      if (it && it.items) { e.preventDefault(); this.positionSub(this.active); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.items[this.active]) this.run(this.items[this.active]);
    }
  }
}
