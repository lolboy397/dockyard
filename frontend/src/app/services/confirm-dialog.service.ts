import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface ConfirmConfig {
  /** Main heading shown in the dialog */
  title: string;
  /** Optional body text with additional context */
  message?: string;
  /** Optional list of detail rows rendered in a scrollable panel below the message */
  items?: string[];
  /** Label for the confirm button — defaults to 'Confirm' */
  confirmLabel?: string;
  /** Render the confirm button in danger red instead of primary blue */
  danger?: boolean;
}

export interface ConfirmWithCheckboxConfig extends ConfirmConfig {
  /** Label shown next to the checkbox */
  checkboxLabel: string;
  /** Initial checked state — defaults to false */
  checkboxDefault?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  readonly request$ = new Subject<{ config: ConfirmConfig; resolve: (v: boolean) => void }>();
  readonly checkboxRequest$ = new Subject<{
    config: ConfirmWithCheckboxConfig;
    resolve: (v: { confirmed: boolean; checked: boolean }) => void;
  }>();

  /**
   * Opens a confirmation dialog and returns a Promise that resolves to
   * `true` when the user confirms, or `false` when they cancel / close.
   */
  confirm(config: ConfirmConfig): Promise<boolean> {
    return new Promise(resolve => {
      this.request$.next({ config, resolve });
    });
  }

  /**
   * Opens a confirmation dialog with a checkbox and returns a Promise that
   * resolves to `{ confirmed, checked }` when dismissed.
   */
  confirmWithCheckbox(config: ConfirmWithCheckboxConfig): Promise<{ confirmed: boolean; checked: boolean }> {
    return new Promise(resolve => {
      this.checkboxRequest$.next({ config, resolve });
    });
  }
}
