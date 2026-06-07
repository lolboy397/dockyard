import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../../components/shared/icon/icon.component';
import { meshFocus, meshBlur } from '../../mesh';

/** Text field with optional lead icon / prefix / trailing tag. Port of components.jsx TextInput. */
@Component({
  selector: 'dy-text-input',
  standalone: true,
  imports: [CommonModule, IconComponent],
  styleUrls: ['./text-input.component.scss'],
  templateUrl: './text-input.component.html',
})
export class DyTextInput implements AfterViewInit {
  @Input() value = '';
  @Input() placeholder?: string;
  @Input() icon?: string;
  @Input() type = 'text';
  @Input() mono = false;
  @Input() prefix?: string;
  @Input() trailTag?: string;
  @Input() autoFocus = false;
  @Input() ok = false;
  @Input() err = false;

  @Output() valueChange = new EventEmitter<string>();
  @Output() enter = new EventEmitter<void>();

  @ViewChild('input') inputRef!: ElementRef<HTMLInputElement>;

  ngAfterViewInit(): void {
    if (this.autoFocus) setTimeout(() => this.inputRef?.nativeElement?.focus(), 0);
  }

  onInput(e: Event): void { this.valueChange.emit((e.target as HTMLInputElement).value); }
  onFocus(e: FocusEvent): void { meshFocus(e); }
  onBlur(): void { meshBlur(); }
}
