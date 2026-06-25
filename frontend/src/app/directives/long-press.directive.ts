import { Directive, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';

/**
 * Adds a touch long-press gesture that mirrors a desktop right-click, so the
 * context menus that are wired to `(contextmenu)` become reachable on phones and
 * tablets. It emits a synthetic `MouseEvent` carrying the press coordinates, so
 * an existing handler can be reused verbatim:
 *
 *   <div (contextmenu)="rowMenu($event, c)" (dyLongPress)="rowMenu($event, c)">
 *
 * Listeners are attached with `{ passive: false }` directly (not via Angular host
 * bindings) because iOS Safari ignores `preventDefault()` from passive listeners,
 * which we need to swallow the tap that would otherwise follow the press.
 */
@Directive({
  selector: '[dyLongPress]',
  standalone: true,
})
export class LongPressDirective implements OnInit, OnDestroy {
  /** Press duration before the gesture fires (ms). */
  @Input() longPressDelay = 500;
  /** Movement (px) that cancels the press — distinguishes press from scroll. */
  @Input() longPressTolerance = 10;
  @Output('dyLongPress') longPress = new EventEmitter<MouseEvent>();

  private timer?: ReturnType<typeof setTimeout>;
  private startX = 0;
  private startY = 0;
  private fired = false;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      const el = this.el.nativeElement;
      el.addEventListener('touchstart', this.onStart, { passive: false });
      el.addEventListener('touchmove', this.onMove, { passive: true });
      el.addEventListener('touchend', this.onEnd, { passive: false });
      el.addEventListener('touchcancel', this.onCancel, { passive: true });
    });
  }

  ngOnDestroy(): void {
    const el = this.el.nativeElement;
    el.removeEventListener('touchstart', this.onStart);
    el.removeEventListener('touchmove', this.onMove);
    el.removeEventListener('touchend', this.onEnd);
    el.removeEventListener('touchcancel', this.onCancel);
    this.clear();
  }

  private onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) { this.clear(); return; }
    const t = e.touches[0];
    this.startX = t.clientX;
    this.startY = t.clientY;
    this.fired = false;
    this.clear();
    this.timer = setTimeout(() => {
      this.fired = true;
      navigator.vibrate?.(10);
      const evt = new MouseEvent('contextmenu', { clientX: this.startX, clientY: this.startY, bubbles: false });
      this.zone.run(() => this.longPress.emit(evt));
    }, this.longPressDelay);
  };

  private onMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - this.startX) > this.longPressTolerance ||
        Math.abs(t.clientY - this.startY) > this.longPressTolerance) {
      this.clear();
    }
  };

  private onEnd = (e: TouchEvent): void => {
    // If the press fired, swallow the synthetic click/callout that follows.
    if (this.fired) { e.preventDefault(); this.fired = false; }
    this.clear();
  };

  private onCancel = (): void => { this.clear(); };

  private clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
}
