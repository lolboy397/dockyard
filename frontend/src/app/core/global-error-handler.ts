import { ErrorHandler, Injectable, Injector, NgZone } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NotificationService } from '../services/notification.service';
import { TelemetryService } from '../services/telemetry.service';

/**
 * Surfaces otherwise-silent uncaught client errors as a toast (and logs them),
 * so failures are visible instead of disappearing. HTTP errors are handled at
 * the call site / interceptor, so they're skipped here to avoid double toasts.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  constructor(private injector: Injector, private zone: NgZone) {}

  handleError(error: unknown): void {
    // eslint-disable-next-line no-console
    console.error(error);

    if (error instanceof HttpErrorResponse) return;

    const message =
      (error as { message?: string })?.message ||
      (typeof error === 'string' ? error : 'Something went wrong');

    // Report to the diagnostics store (best-effort; never let it break handling).
    try {
      this.injector.get(TelemetryService).report('error', message, { stack: (error as { stack?: string })?.stack });
    } catch {
      /* telemetry not available yet */
    }

    try {
      const notify = this.injector.get(NotificationService);
      this.zone.run(() => notify.error(message));
    } catch {
      /* notification service not yet available (very early errors) */
    }
  }
}
