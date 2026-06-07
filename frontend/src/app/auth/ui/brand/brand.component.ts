import { Component, Input } from '@angular/core';

/** The cyan container glyph. Port of app-auth/components.jsx BrandMark. */
@Component({
  selector: 'dy-brand-mark',
  standalone: true,
  styleUrls: ['./brand.component.scss'],
  templateUrl: './brand.component.html',
})
export class DyBrandMark {
  @Input() size = 26;
  @Input() lg = false;
}

/** Brand lockup: mark + wordmark. Port of app-auth/components.jsx Brand. */
@Component({
  selector: 'dy-brand',
  standalone: true,
  imports: [DyBrandMark],
  styles: [':host { display: contents; }'],
  template: `
    <div class="brand">
      <dy-brand-mark [size]="lg ? 30 : 26" [lg]="lg"></dy-brand-mark>
      <span [class]="'brand-word ' + (lg ? 'lg' : '')">Dockyard</span>
    </div>
  `,
})
export class DyBrand {
  @Input() size: 'md' | 'lg' = 'md';
  get lg(): boolean { return this.size === 'lg'; }
}
