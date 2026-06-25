import { Component, Input, Output, EventEmitter, HostListener, ViewChild, ElementRef, NgZone, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../icon/icon.component';

/**
 * Reusable modal/dialog following the Dockyard design system.
 *
 * Usage:
 *   <app-modal title="My dialog" [size]="'lg'" (close)="showModal=false">
 *     <!-- body content projected here -->
 *
 *     <div modal-footer>
 *       <button class="btn btn-sm btn-ghost" (click)="showModal=false">Cancel</button>
 *       <button class="btn btn-sm btn-primary" (click)="submit()">Save</button>
 *     </div>
 *   </app-modal>
 *
 * Inputs:
 *   title   — main heading shown in the dialog header
 *   eyebrow — optional small-caps label above the title (e.g. "new · builds")
 *   size    — 'sm' (360px) | 'md' (480px, default) | 'lg' (600px)
 *
 * The dialog closes on: backdrop click, × button, or Escape key.
 */
@Component({
  selector: 'app-modal',
  standalone: true,
  imports: [CommonModule, IconComponent],
  templateUrl: './modal.component.html',
})
export class ModalComponent implements AfterViewInit, OnDestroy {
  @Input() title = '';
  @Input() eyebrow = '';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Output() close = new EventEmitter<void>();

  @ViewChild('modalEl') private modalEl?: ElementRef<HTMLElement>;
  @ViewChild('headEl') private headEl?: ElementRef<HTMLElement>;

  // Swipe-down-to-dismiss for the phone bottom-sheet. Handlers run OUTSIDE the
  // Angular zone and write transforms straight to the DOM (no CD per frame), and
  // touchmove is a non-passive native listener so preventDefault() actually stops
  // the page panning on iOS.
  private startY = 0;
  private dragY = 0;
  private dragging = false;

  constructor(private zone: NgZone) {}

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit();
  }

  onBackdrop(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close.emit();
    }
  }

  ngAfterViewInit(): void {
    const head = this.headEl?.nativeElement;
    if (!head) return;
    this.zone.runOutsideAngular(() => {
      head.addEventListener('touchstart', this.onStart, { passive: true });
      head.addEventListener('touchmove', this.onMove, { passive: false });
      head.addEventListener('touchend', this.onEnd, { passive: true });
      head.addEventListener('touchcancel', this.onEnd, { passive: true });
    });
  }

  ngOnDestroy(): void {
    const head = this.headEl?.nativeElement;
    if (!head) return;
    head.removeEventListener('touchstart', this.onStart);
    head.removeEventListener('touchmove', this.onMove);
    head.removeEventListener('touchend', this.onEnd);
    head.removeEventListener('touchcancel', this.onEnd);
  }

  private onStart = (e: TouchEvent): void => {
    if (window.innerWidth > 820 || e.touches.length !== 1) return;       // phone sheet only
    if ((e.target as HTMLElement).closest('button')) return;             // not a header button
    this.startY = e.touches[0].clientY;
    this.dragging = true;
    const el = this.modalEl?.nativeElement;
    if (el) el.style.animation = 'none'; // don't let the sheet-up entrance fight the drag
  };

  private onMove = (e: TouchEvent): void => {
    if (!this.dragging) return;
    this.dragY = Math.max(0, e.touches[0].clientY - this.startY);
    e.preventDefault(); // non-passive — stop the page from panning under the drag
    const el = this.modalEl?.nativeElement;
    if (el) { el.style.transition = 'none'; el.style.transform = `translateY(${this.dragY}px)`; }
  };

  private onEnd = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragY > 110) { this.zone.run(() => this.close.emit()); return; } // leave it down; the @if removes us
    const el = this.modalEl?.nativeElement;
    if (el) { el.style.transition = 'transform 0.2s ease'; el.style.transform = ''; }
    this.dragY = 0;
  };
}
