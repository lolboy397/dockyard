import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  readonly toasts$ = new BehaviorSubject<Toast[]>([]);

  show(message: string, tone: ToastTone = 'info', duration = 4000): void {
    const id = this.nextId++;
    const current = this.toasts$.value;
    this.toasts$.next([...current, { id, message, tone }]);
    setTimeout(() => this.dismiss(id), duration);
  }

  success(message: string): void { this.show(message, 'success', 3500); }
  error(message: string):   void { this.show(message, 'error',   6000); }
  info(message: string):    void { this.show(message, 'info',    3500); }

  dismiss(id: number): void {
    this.toasts$.next(this.toasts$.value.filter(t => t.id !== id));
  }
}
