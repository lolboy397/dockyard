import { Directive, ElementRef, EventEmitter, NgZone, OnDestroy, OnInit, Output, Renderer2 } from '@angular/core';

/**
 * Pull-to-refresh for a scroll container. Engages only when scrolled to the top
 * and dragging DOWN, so it never fights normal scrolling (no overscroll-behavior
 * relaxing → no iOS standalone bounce). Instead of transforming the container
 * (which an overflow:hidden ancestor would clip), it grows the container's
 * padding-top and reveals a pinned indicator in that space. Emits when released
 * past the threshold.
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
  private indicator?: HTMLElement;
  private readonly threshold = 60;
  private readonly max = 76;

  constructor(private el: ElementRef<HTMLElement>, private zone: NgZone, private r: Renderer2) {}

  ngOnInit(): void {
    const host = this.el.nativeElement;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const ind: HTMLElement = this.r.createElement('div');
    ind.className = 'ptr-indicator';
    ind.textContent = '↓';
    this.indicator = ind;
    this.r.appendChild(host, ind);

    this.zone.runOutsideAngular(() => {
      host.addEventListener('touchstart', this.onStart, { passive: true });
      host.addEventListener('touchmove', this.onMove, { passive: false });
      host.addEventListener('touchend', this.onEnd, { passive: true });
      host.addEventListener('touchcancel', this.onEnd, { passive: true });
    });
  }

  ngOnDestroy(): void {
    const host = this.el.nativeElement;
    host.removeEventListener('touchstart', this.onStart);
    host.removeEventListener('touchmove', this.onMove);
    host.removeEventListener('touchend', this.onEnd);
    host.removeEventListener('touchcancel', this.onEnd);
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
    if (dy <= 0 || this.el.nativeElement.scrollTop > 0) { this.reset(true); return; }
    e.preventDefault();                       // we own the gesture (at top, pulling down)
    this.dist = Math.min(this.max, dy * 0.5); // rubber-band damping
    this.apply(this.dist, false);
  };

  private onEnd = (): void => {
    if (!this.active) return;
    const fire = this.dist >= this.threshold;
    this.active = false;
    this.reset(true);
    if (fire) this.zone.run(() => this.refresh.emit());
  };

  private apply(px: number, animate: boolean): void {
    const host = this.el.nativeElement;
    host.style.transition = animate ? 'padding-top 0.2s ease' : '';
    host.style.paddingTop = px ? `${px}px` : '';
    const ind = this.indicator;
    if (ind) {
      ind.style.height = `${px}px`;
      ind.style.opacity = px ? String(Math.min(1, px / this.threshold)) : '0';
      ind.classList.toggle('ptr-armed', px >= this.threshold);
    }
  }

  // Animated snap-back so cancelling a pull mid-gesture matches the release path.
  private reset(animate: boolean): void {
    this.active = false;
    this.dist = 0;
    this.apply(0, animate);
  }
}
