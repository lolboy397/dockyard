import { Component, Input, Output, EventEmitter, HostListener } from '@angular/core';
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
export class ModalComponent {
  @Input() title = '';
  @Input() eyebrow = '';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Output() close = new EventEmitter<void>();

  // Swipe-down-to-dismiss for the phone bottom-sheet presentation.
  dragY = 0;
  dragging = false;
  private startY = 0;

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit();
  }

  onBackdrop(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close.emit();
    }
  }

  onHeadTouchStart(e: TouchEvent): void {
    // Only on the phone sheet, and not when grabbing a header button.
    if (window.innerWidth > 820 || e.touches.length !== 1) return;
    if ((e.target as HTMLElement).closest('button')) return;
    this.startY = e.touches[0].clientY;
    this.dragging = true;
  }

  onHeadTouchMove(e: TouchEvent): void {
    if (!this.dragging) return;
    this.dragY = Math.max(0, e.touches[0].clientY - this.startY); // downward only
  }

  onHeadTouchEnd(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragY > 110) this.close.emit();
    this.dragY = 0;
  }
}
