import { Directive, ElementRef, EventEmitter, NgZone, OnDestroy, OnInit, Output } from '@angular/core';

/**
 * Pull-to-refresh for a scroll container. Engages only when the container is
 * scrolled to the very top and the user drags DOWN, so it never fights normal
 * scrolling (and doesn't require relaxing overscroll-behavior, which would
 * re-introduce the iOS standalone bounce). Emits when released past the
 * threshold; the host is translated down as live feedback and snaps back.
 *
 *   <div class="list" dyPullToRefresh (dyPullToRefresh)="reload()">
 */
@Directive({
  selector: '[dyPullToRefresh]',
  standalone: true,
})
export class PullToRefreshDirective implements OnInit, OnDestroy {
  @Output('dyPullToRefresh') refresh = new EventEmitter<void>();

  private startY = 0;
  private dist = 0;
  private active = false;
  private readonly threshold = 64;
  private readonly max = 96;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnInit(): void {
    this.zone.runOutsideAngular(() => {
      const el = this.el.nativeElement;
      el.addEventListener('touchstart', this.onStart, { passive: true });
      el.addEventListener('touchmove', this.onMove, { passive: false });
      el.addEventListener('touchend', this.onEnd, { passive: true });
      el.addEventListener('touchcancel', this.onEnd, { passive: true });
    });
  }

  ngOnDestroy(): void {
    const el = this.el.nativeElement;
    el.removeEventListener('touchstart', this.onStart);
    el.removeEventListener('touchmove', this.onMove);
    el.removeEventListener('touchend', this.onEnd);
    el.removeEventListener('touchcancel', this.onEnd);
  }

  private onStart = (e: TouchEvent): void => {
    if (this.el.nativeElement.scrollTop > 0 || e.touches.length !== 1) { this.active = false; return; }
    this.startY = e.touches[0].clientY;
    this.active = true;
    this.dist = 0;
  };

  private onMove = (e: TouchEvent): void => {
    if (!this.active) return;
    const dy = e.touches[0].clientY - this.startY;
    if (dy <= 0 || this.el.nativeElement.scrollTop > 0) { this.reset(); return; }
    e.preventDefault();                     // we own the gesture (at top, pulling down)
    this.dist = Math.min(this.max, dy * 0.5); // rubber-band damping
    this.apply(this.dist, false);
  };

  private onEnd = (): void => {
    if (!this.active) return;
    const fire = this.dist >= this.threshold;
    this.active = false;
    this.apply(0, true);
    if (fire) this.zone.run(() => this.refresh.emit());
  };

  private apply(px: number, animate: boolean): void {
    const el = this.el.nativeElement;
    el.style.transition = animate ? 'transform 0.2s ease' : '';
    el.style.transform = px ? `translateY(${px}px)` : '';
    el.classList.toggle('ptr-armed', px >= this.threshold);
  }

  private reset(): void {
    this.active = false;
    this.apply(0, false);
  }
}
