import { Injectable } from '@angular/core';
import { ToastService } from './toast.service';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  constructor(private toast: ToastService) {}

  success(message: string): void { this.toast.success(message); }
  error(message: string):   void { this.toast.error(message); }
  info(message: string):    void { this.toast.info(message); }
}
