import { Component, Input, ElementRef, AfterViewInit, OnChanges, NgZone } from '@angular/core';

declare const lucide: any;

/**
 * Dockyard icon wrapper for Lucide icons (CDN).
 * Usage: <dy-icon name="box" [size]="16"></dy-icon>
 *
 * Optional inputs mirror the design-system Icon primitive:
 *   [strokeWidth] — line weight (default 1.5)
 *   [color]       — explicit color; when unset, inherits currentColor
 */
@Component({
  selector: 'dy-icon',
  standalone: true,
  template: '',
})
export class IconComponent implements AfterViewInit, OnChanges {
  @Input() name = '';
  @Input() size = 16;
  @Input() strokeWidth = 1.5;
  @Input() color = '';

  constructor(private host: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngAfterViewInit(): void { this.paint(); }

  ngOnChanges(): void { this.paint(); }

  private paint(): void {
    this.zone.runOutsideAngular(() => {
      const el = this.host.nativeElement;
      el.style.display = 'inline-flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.flex = 'none';
      el.style.width = `${this.size}px`;
      el.style.height = `${this.size}px`;
      el.style.color = this.color || '';
      el.innerHTML = `<i data-lucide="${this.name}"></i>`;
      if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons({
          nameAttr: 'data-lucide',
          attrs: { width: this.size, height: this.size, 'stroke-width': this.strokeWidth },
        });
      }
    });
  }
}
