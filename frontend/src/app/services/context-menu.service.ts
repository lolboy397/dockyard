import { Injectable, signal } from '@angular/core';

/**
 * Reusable right-click context-menu service — a 1:1 port of the design-system
 * `ContextMenu.jsx` menu API (see system_design/.../app/ContextMenu.jsx).
 *
 * Usage:
 *   constructor(public menu: ContextMenuService) {}
 *   onRowMenu(e: MouseEvent, row) {
 *     this.menu.open(e, this.buildItems(row), { header: { name, meta, icon } });
 *   }
 *
 * Item shapes (mirrors the mockup):
 *   { label, icon, shortcut, onSelect, danger, accent, disabled }
 *   { label, icon, items: [...] }              // submenu
 *   { label, icon, checked: bool, onSelect }   // toggle row
 *   { type: 'separator' }
 *   { type: 'label', label }                   // section heading
 */

export interface ContextMenuHeader {
  /** Primary line — the target's name. */
  name: string;
  /** Secondary mono line — image tag, size, id, etc. */
  meta?: string;
  /** Lucide icon name for the header chip. */
  icon?: string;
}

export interface ContextMenuItem {
  /** Special rows: a divider or a section heading. */
  type?: 'separator' | 'label';
  label?: string;
  /** Lucide icon name. */
  icon?: string;
  /** Trailing keyboard hint, e.g. '⌘R'. */
  shortcut?: string;
  /** Invoked on click / Enter; the menu closes afterwards. */
  onSelect?: () => void;
  /** Red, destructive styling. */
  danger?: boolean;
  /** Accent-coloured icon (primary action, e.g. View). */
  accent?: boolean;
  disabled?: boolean;
  /** When set, renders a check on the trailing edge (toggle row). */
  checked?: boolean;
  /** Nested submenu. */
  items?: ContextMenuItem[];
}

export interface ContextMenuOptions {
  /** Override the anchor point (defaults to the event's client coords). */
  x?: number;
  y?: number;
  header?: ContextMenuHeader;
}

export interface OpenContextMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
  header?: ContextMenuHeader;
}

@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  /** The currently-open menu, or null when nothing is shown. */
  readonly menu = signal<OpenContextMenu | null>(null);

  /**
   * Open the menu. Mirrors the mockup's `openMenu(e, items, opts)`:
   * cancels the native menu, then anchors at the pointer (or `opts.x/y`).
   */
  open(e: MouseEvent | null, items: ContextMenuItem[], opts: ContextMenuOptions = {}): void {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const x = opts.x != null ? opts.x : (e ? e.clientX : 0);
    const y = opts.y != null ? opts.y : (e ? e.clientY : 0);
    this.menu.set({ x, y, items, header: opts.header });
  }

  close(): void {
    this.menu.set(null);
  }
}
