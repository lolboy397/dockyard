import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../../components/shared/icon/icon.component';
import { meshFocus, meshBlur } from '../../mesh';

/** Password field with reveal toggle. Port of components.jsx PasswordInput. */
@Component({
  selector: 'dy-password-input',
  standalone: true,
  imports: [CommonModule, IconComponent],
  styleUrls: ['./password-input.component.scss'],
  templateUrl: './password-input.component.html',
})
export class DyPasswordInput implements AfterViewInit {
  @Input() value = '';
  @Input() placeholder?: string;
  @Input() autoFocus = false;
  @Input() err = false;
  @Input() icon = 'lock';

  @Output() valueChange = new EventEmitter<string>();
  @Output() enter = new EventEmitter<void>();

  @ViewChild('input') inputRef!: ElementRef<HTMLInputElement>;

  show = false;

  ngAfterViewInit(): void {
    if (this.autoFocus) setTimeout(() => this.inputRef?.nativeElement?.focus(), 0);
  }

  onInput(e: Event): void { this.valueChange.emit((e.target as HTMLInputElement).value); }
  onFocus(e: FocusEvent): void { meshFocus(e); }
  onBlur(): void { meshBlur(); }
}
