import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../components/shared/icon/icon.component';
import { AuthService } from './auth.service';
import { DEFAULT_DATA, SetupData } from './auth.models';
import { AuthBackgroundComponent } from './auth-background/auth-background.component';
import { SetupWizardComponent } from './setup-wizard/setup-wizard.component';
import { LoginScreenComponent } from './login-screen/login-screen.component';

/**
 * Port of app-auth/main.jsx Root — the full-viewport auth stage that hosts the
 * first-run setup wizard and the login screen, with the prototype mode-switch.
 */
@Component({
  selector: 'dy-auth',
  standalone: true,
  host: { class: 'dy-auth' },
  imports: [CommonModule, IconComponent, AuthBackgroundComponent, SetupWizardComponent, LoginScreenComponent],
  templateUrl: './auth.component.html',
})
export class AuthComponent implements OnInit {
  mode: 'setup' | 'login' = 'setup';
  data: SetupData = { ...DEFAULT_DATA };
  completedUser: string | null = null;

  constructor(private auth: AuthService) {}

  ngOnInit(): void {
    // Mode is derived from instance state: first-run setup until an admin
    // exists, then the login screen.
    this.mode = this.auth.status()?.setup_complete ? 'login' : 'setup';
  }

  onSetupFinish(): void {
    this.completedUser = this.data.username || 'admin';
    this.mode = 'login';
  }

  onSignedIn(): void {
    this.auth.markAuthed();
  }
}
