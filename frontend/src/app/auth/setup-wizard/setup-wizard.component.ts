import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../components/shared/icon/icon.component';
import { AuthService } from '../auth.service';
import { meshBurstFrom } from '../mesh';
import { SetupData } from '../auth.models';
import { DyBrandMark } from '../ui/brand/brand.component';
import { DyField } from '../ui/field/field.component';
import { DyTextInput } from '../ui/text-input/text-input.component';
import { DyPasswordInput } from '../ui/password-input/password-input.component';
import { DyPasswordStrength } from '../ui/password-strength/password-strength.component';
import { DyCheckRow } from '../ui/check-row/check-row.component';
import { DyBtn } from '../ui/btn/btn.component';

interface Step { id: string; label: string; }

const STEPS: Step[] = [
  { id: 'welcome',  label: 'Welcome' },
  { id: 'admin',    label: 'Admin account' },
  { id: 'instance', label: 'Instance' },
  { id: 'review',   label: 'Review' },
];

const FEATURES = [
  { ic: 'box', t: 'Manage your whole fleet', d: 'Containers, images, volumes and networks — across every host, in one place.' },
  { ic: 'shield-check', t: 'Self-hosted & private', d: 'Runs entirely on your infrastructure. Your data never leaves this machine.' },
  { ic: 'terminal', t: 'Built for the terminal', d: 'Keyboard-first, mono-comfortable, and fast. The docker manager you’d actually pay for.' },
];

/** Port of app-auth/setup.jsx — wired to /auth/setup + /auth/test-connection. */
@Component({
  selector: 'dy-setup-wizard',
  standalone: true,
  imports: [
    CommonModule, IconComponent,
    DyBrandMark, DyField, DyTextInput, DyPasswordInput, DyPasswordStrength, DyCheckRow, DyBtn,
  ],
  templateUrl: './setup-wizard.component.html',
})
export class SetupWizardComponent {
  @Input() data!: SetupData;
  @Output() finished = new EventEmitter<void>();

  steps = STEPS;
  features = FEATURES;

  stepIdx = 0;
  maxReached = 0;
  finishing = false;

  // instance-step local state
  testing = false;
  tested = false;
  testOk = false;
  testMessage = '';

  constructor(private auth: AuthService) {}

  get step(): Step { return STEPS[this.stepIdx]; }
  get progress(): number { return (this.stepIdx / (STEPS.length - 1)) * 100; }
  get engineVersion(): string { return this.auth.status()?.engine_version || '26.1.4'; }

  get mismatch(): boolean { return this.data.confirm.length > 0 && this.data.confirm !== this.data.password; }

  get pwMask(): string { return '•'.repeat(Math.max(8, this.data.password.length || 10)); }

  // per-step validity gate
  get valid(): boolean {
    const d = this.data;
    switch (this.step.id) {
      case 'welcome':  return d.accepted;
      case 'admin':    return !!d.fullName.trim() && /\S+@\S+\.\S+/.test(d.email) && d.username.trim().length >= 3
                              && d.password.length >= 8 && d.password === d.confirm;
      case 'instance': return !!d.instanceName.trim();
      default:         return true;
    }
  }

  setUsername(v: string): void { this.data.username = v.toLowerCase().replace(/\s/g, ''); }

  go(i: number): void {
    this.stepIdx = i;
    this.maxReached = Math.max(this.maxReached, i);
    // each visit to the instance step starts with a clean test result
    this.testing = false;
    this.tested = false;
  }
  next(): void { this.go(Math.min(this.stepIdx + 1, STEPS.length - 1)); }
  back(): void { this.go(Math.max(this.stepIdx - 1, 0)); }

  runTest(): void {
    this.testing = true; this.tested = false;
    this.auth.testConnection().subscribe(res => {
      this.testing = false;
      this.tested = true;
      this.testOk = !!res.ok;
      this.testMessage = res.ok
        ? `connected · ${res.containers} containers · ${res.images} images`
        : (res.error || 'connection failed');
    });
  }

  doFinish(): void {
    this.finishing = true;
    meshBurstFrom(document.querySelector('.setup-foot .btn-primary'), 8);
    // create the admin + instance config on the backend; the success overlay
    // plays for the same beat as the prototype before handing off to sign in.
    this.auth.setup(this.data).subscribe({ next: () => {}, error: () => {} });
    setTimeout(() => this.finished.emit(), 1800);
  }
}
