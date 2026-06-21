import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../components/shared/icon/icon.component';
import { AuthService } from '../auth.service';
import { meshBurstFrom } from '../mesh';
import { DyBrand } from '../ui/brand/brand.component';
import { DyField } from '../ui/field/field.component';
import { DyTextInput } from '../ui/text-input/text-input.component';
import { DyPasswordInput } from '../ui/password-input/password-input.component';
import { DyCheckRow } from '../ui/check-row/check-row.component';
import { DyBtn } from '../ui/btn/btn.component';

/** Port of app-auth/login.jsx — wired to the real /auth/login endpoint. */
@Component({
  selector: 'dy-login-screen',
  standalone: true,
  imports: [CommonModule, IconComponent, DyBrand, DyField, DyTextInput, DyPasswordInput, DyCheckRow, DyBtn],
  templateUrl: './login-screen.component.html',
})
export class LoginScreenComponent implements OnInit {
  @Input() knownUser: string | null = null;
  @Output() signedIn = new EventEmitter<string>();

  username = '';
  password = '';
  remember = true;
  loading = false;
  error: string | null = null;
  done = false;

  constructor(private auth: AuthService) {}

  ngOnInit(): void {
    this.username = this.knownUser || '';
  }

  get canSubmit(): boolean { return !!this.username.trim() && this.password.length > 0; }

  get engineVersion(): string { return this.auth.status()?.engine_version || '26.1.4'; }
  get appVersion(): string { return this.auth.status()?.app_version || '0.0.4'; }

  submit(): void {
    if (!this.canSubmit || this.loading) return;
    this.error = null;
    this.loading = true;
    // fire a packet burst from the mesh node nearest the Sign in button
    meshBurstFrom(document.querySelector('.login-card .btn-primary'), 7);

    this.auth.login(this.username, this.password, this.remember).subscribe({
      next: () => {
        this.loading = false;
        this.done = true;
        // let the success card's fill-bar play, then enter the app
        setTimeout(() => this.signedIn.emit(this.username), 1500);
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.error || 'Invalid username or password.';
      },
    });
  }
}
