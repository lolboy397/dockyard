import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, Toast } from '../../../services/toast.service';
import { IconComponent } from '../icon/icon.component';

@Component({
  selector: 'dy-toast-container',
  standalone: true,
  imports: [CommonModule, IconComponent],
  templateUrl: './toast-container.component.html',
})
export class ToastContainerComponent implements OnInit {
  toasts: Toast[] = [];

  constructor(readonly svc: ToastService) {}

  ngOnInit(): void {
    this.svc.toasts$.subscribe(t => this.toasts = t);
  }

  iconFor(tone: string): string {
    if (tone === 'success') return 'circle-check';
    if (tone === 'error')   return 'circle-alert';
    return 'info';
  }

  colorFor(tone: string): string {
    if (tone === 'success') return 'var(--running-400)';
    if (tone === 'error')   return 'var(--danger-400)';
    return 'var(--info-400)';
  }
}
