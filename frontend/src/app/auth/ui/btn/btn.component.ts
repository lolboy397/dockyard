import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IconComponent } from '../../../components/shared/icon/icon.component';

/** Button matching app.css button styles. Port of components.jsx Btn. */
@Component({
  selector: 'dy-btn',
  standalone: true,
  imports: [CommonModule, IconComponent],
  styleUrls: ['./btn.component.scss'],
  templateUrl: './btn.component.html',
})
export class DyBtn implements AfterViewInit {
  @Input() variant: 'primary' | 'secondary' | 'ghost' = 'secondary';
  @Input() icon?: string | null;
  @Input() iconRight?: string;
  @Input() disabled = false;
  @Input() block = false;
  @Input() loading = false;
  @Input() type = 'button';
  @Output() clicked = new EventEmitter<MouseEvent>();

  @ViewChild('label') labelRef!: ElementRef<HTMLElement>;
  hasLabel = true;

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.hasLabel = !!this.labelRef.nativeElement.textContent?.trim();
    this.cdr.detectChanges();
  }
}
