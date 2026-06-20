import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

/**
 * Renders a tiny subset of inline markdown — **bold** and `code` — as safe HTML.
 * The input is HTML-escaped first, so even untrusted text can't inject markup;
 * only the bold/code wrappers we add are trusted.
 */
@Pipe({ name: 'mdInline', standalone: true })
export class MdInlinePipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(value: string): SafeHtml {
    const escaped = (value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const html = escaped
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
