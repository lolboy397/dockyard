import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { ConfirmDialogService, ConfirmConfig, ConfirmWithCheckboxConfig } from '../../../services/confirm-dialog.service';
import { ModalComponent } from '../modal/modal.component';

/**
 * Renders the confirm/danger dialog driven by ConfirmDialogService.
 * Mount once in app.component.html — it is hidden until a confirmation is requested.
 *
 * Usage in any component:
 *   constructor(private confirm: ConfirmDialogService) {}
 *
 *   async remove(item: Item): Promise<void> {
 *     const ok = await this.confirm.confirm({
 *       title: 'Remove container?',
 *       message: 'This cannot be undone.',
 *       confirmLabel: 'Remove',
 *       danger: true,
 *     });
 *     if (!ok) return;
 *     // proceed with removal
 *   }
 */
@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, ModalComponent],
  templateUrl: './confirm-dialog.component.html',
})
export class ConfirmDialogComponent implements OnInit, OnDestroy {
  visible = false;
  config: ConfirmConfig = { title: '' };
  checkboxConfig: ConfirmWithCheckboxConfig | null = null;
  isCheckbox = false;
  checkboxChecked = false;

  private resolve?: (v: boolean) => void;
  private resolveWithCheckbox?: (v: { confirmed: boolean; checked: boolean }) => void;
  private sub?: Subscription;
  private checkboxSub?: Subscription;

  constructor(private confirmSvc: ConfirmDialogService) {}

  ngOnInit(): void {
    this.sub = this.confirmSvc.request$.subscribe(({ config, resolve }) => {
      this.config = config;
      this.resolve = resolve;
      this.isCheckbox = false;
      this.checkboxConfig = null;
      this.visible = true;
    });
    this.checkboxSub = this.confirmSvc.checkboxRequest$.subscribe(({ config, resolve }) => {
      this.config = config;
      this.checkboxConfig = config;
      this.checkboxChecked = config.checkboxDefault ?? false;
      this.resolveWithCheckbox = resolve;
      this.isCheckbox = true;
      this.visible = true;
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.checkboxSub?.unsubscribe();
  }

  respond(value: boolean): void {
    this.visible = false;
    if (this.isCheckbox && this.resolveWithCheckbox) {
      this.resolveWithCheckbox({ confirmed: value, checked: this.checkboxChecked });
      this.resolveWithCheckbox = undefined;
    } else {
      this.resolve?.(value);
      this.resolve = undefined;
    }
  }
}
