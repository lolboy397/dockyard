import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../../components/shared/icon/icon.component';

/** Labelled form field with optional hint or error. Port of components.jsx Field. */
@Component({
  selector: 'dy-field',
  standalone: true,
  imports: [CommonModule, IconComponent],
  styleUrls: ['./field.component.scss'],
  templateUrl: './field.component.html',
})
export class DyField {
  @Input() label?: string;
  @Input() optional = false;
  @Input() hint?: string | null;
  @Input() error?: string | null;
}
