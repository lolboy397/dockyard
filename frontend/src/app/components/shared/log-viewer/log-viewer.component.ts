import { Component, Input, ViewChild, ElementRef, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

interface LogLine { n: number; cls: string; text: string; }

/**
 * Shared log viewer — renders raw log strings as colour-coded lines with prefix chars.
 * Used by both the Projects page (build/run logs) and the Builds page (run logs).
 *
 * Line classification:
 *   lline-step  — Docker step headers (Step N/N, #N [N/N])  → cyan / accent
 *   lline-err   — error / failed lines                       → red / danger
 *   lline-ok    — success lines (Successfully built / DONE)  → bright green
 *   lline-dim   — cached / context transfer lines            → fg-subtle
 */
@Component({
  selector: 'app-log-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './log-viewer.component.html',
  styleUrls: ['./log-viewer.component.scss']
})
export class LogViewerComponent implements OnChanges {
  @Input() logs = '';
  @Input() live = false;
  @Input() autoScroll = true;

  @ViewChild('logEl') logEl!: ElementRef<HTMLDivElement>;

  parsedLines: LogLine[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['logs']) {
      this.parsedLines = this.parseLines(this.logs);
      if (this.autoScroll) {
        setTimeout(() => this.scrollToBottom(), 0);
      }
    }
  }

  scrollToBottom(): void {
    if (this.logEl?.nativeElement) {
      this.logEl.nativeElement.scrollTop = this.logEl.nativeElement.scrollHeight;
    }
  }

  linePrefix(cls: string): string {
    if (cls === 'lline-ok') return '✓';
    if (cls === 'lline-dim') return ' ';
    return '›';
  }

  private parseLines(raw: string): LogLine[] {
    if (!raw?.trim()) return [];
    return raw.split('\n')
      .filter(t => t.trim())
      .map((text, i) => ({ n: i + 1, cls: this.lineClass(text), text }));
  }

  private lineClass(line: string): string {
    if (/Step \d+\/\d+|^#\d+ \[\d+\/\d+\]/.test(line)) return 'lline-step';
    if (/error|failed|ERROR|FAILED/i.test(line)) return 'lline-err';
    if (/Successfully built|Successfully tagged|DONE/i.test(line)) return 'lline-ok';
    if (/^#\d+ CACHED|Sending build context|From /i.test(line)) return 'lline-dim';
    return '';
  }
}
