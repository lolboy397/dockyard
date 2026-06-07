import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface PwReqs { len: boolean; upper: boolean; num: boolean; sym: boolean; }
export interface PwScore { reqs: PwReqs; met: number; score: number; }

/** Port of components.jsx scorePassword. */
export function scorePassword(pw: string): PwScore {
  const reqs: PwReqs = {
    len: pw.length >= 10,
    upper: /[A-Z]/.test(pw),
    num: /[0-9]/.test(pw),
    sym: /[^A-Za-z0-9]/.test(pw),
  };
  const met = Object.values(reqs).filter(Boolean).length;
  return { reqs, met, score: pw.length === 0 ? 0 : met };
}

const LEVELS = [
  { label: '', color: 'var(--ink-4)' },
  { label: 'weak', color: 'var(--danger-500)' },
  { label: 'fair', color: 'var(--warn-500)' },
  { label: 'good', color: 'var(--warn-400)' },
  { label: 'strong', color: 'var(--running-500)' },
];

/** Port of components.jsx PasswordStrength + Req. */
@Component({
  selector: 'dy-password-strength',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./password-strength.component.scss'],
  templateUrl: './password-strength.component.html',
})
export class DyPasswordStrength {
  @Input() value = '';
  get scored(): PwScore { return scorePassword(this.value); }
  get score(): number { return this.scored.score; }
  get lvl() { return LEVELS[this.score]; }
}
