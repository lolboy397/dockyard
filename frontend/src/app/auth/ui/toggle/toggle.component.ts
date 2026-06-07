import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Toggle row with title + description. Port of components.jsx Toggle. */
@Component({
  selector: 'dy-toggle',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./toggle.component.scss'],
  templateUrl: './toggle.component.html',
})
export class DyToggle {
  @Input() on = false;
  @Input() title = '';
  @Input() desc?: string;
  @Output() toggled = new EventEmitter<void>();
}
