import { Component, EventEmitter, Input, Output } from '@angular/core';
import { IconComponent } from '../../../components/shared/icon/icon.component';

/** Inline checkbox row. Port of components.jsx CheckRow. Label via projection. */
@Component({
  selector: 'dy-check-row',
  standalone: true,
  imports: [IconComponent],
  styleUrls: ['./check-row.component.scss'],
  templateUrl: './check-row.component.html',
})
export class DyCheckRow {
  @Input() on = false;
  @Output() toggled = new EventEmitter<void>();
}
