import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { TelemetryService } from '../services/telemetry.service';

function pathOf(url: string): string {
  try { return new URL(url, location.origin).pathname; } catch { return url.split('?')[0]; }
}

/**
 * Reports NETWORK failures (status 0 — offline, server unreachable, CORS) for API
 * calls to the diagnostics store. These are the failures the backend never sees.
 * 5xx are already captured server-side with full detail, and 4xx are usually
 * expected validation, so neither is reported here (avoids double-recording).
 * The telemetry flush uses fetch (not HttpClient), so it can't loop through this.
 */
export const telemetryInterceptor: HttpInterceptorFn = (req, next) => {
  const telemetry = inject(TelemetryService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 0 && req.url.startsWith('/api/')) {
        const p = pathOf(req.url);
        telemetry.report('error', `Network request failed: ${req.method} ${p}`, {
          component: p,
          context: { kind: 'network', method: req.method },
        });
      }
      return throwError(() => err);
    }),
  );
};
