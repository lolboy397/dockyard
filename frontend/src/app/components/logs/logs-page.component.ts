import { Component, OnInit, OnDestroy, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { IconComponent } from '../shared/icon/icon.component';
import { StatusDotComponent } from '../shared/status-dot/status-dot.component';
import { DockerService } from '../../services/docker.service';
import { WebSocketService } from '../../services/websocket.service';
import { ContainerSummary } from '../../models/docker.models';

interface LogSource {
  id: string;
  name: string;
  color: string;
  on: boolean;
  count: number;
  sub?: Subscription;
}

interface LogLine {
  ts: string;
  src: string;
  color: string;
  level: string;
  msg: string;
}

const SOURCE_COLORS = [
  '#22D3EE', '#34D399', '#60A5FA', '#FBBF24',
  '#A78BFA', '#F472B6', '#FB923C', '#4ADE80',
];

@Component({
  selector: 'app-logs-page',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, StatusDotComponent],
  templateUrl: './logs-page.component.html',
})
export class LogsPageComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('logStream') logStreamEl?: ElementRef<HTMLDivElement>;

  sources: LogSource[] = [];
  lines: LogLine[] = [];
  paused = false;
  filterText = '';
  level = 'all';
  levels = ['all', 'info', 'warn', 'error'];
  private shouldScroll = true;
  private lineCountThisSecond = 0;
  lps = 0;
  private lpsInterval?: any;

  get activeSources(): LogSource[] { return this.sources.filter(s => s.on); }

  get filteredLines(): LogLine[] {
    let result = this.lines;
    if (this.level !== 'all') {
      result = result.filter(l => l.level === this.level || l.level.startsWith(this.level[0]));
    }
    if (this.filterText) {
      const f = this.filterText.toLowerCase();
      result = result.filter(l => l.msg.toLowerCase().includes(f) || l.src.toLowerCase().includes(f));
    }
    return result;
  }

  constructor(private docker: DockerService, private ws: WebSocketService) {}

  ngOnInit(): void {
    this.loadContainers();
    this.lpsInterval = setInterval(() => {
      this.lps = this.lineCountThisSecond;
      this.lineCountThisSecond = 0;
    }, 1000);
  }

  ngOnDestroy(): void {
    this.sources.forEach(s => s.sub?.unsubscribe());
    clearInterval(this.lpsInterval);
  }

  ngAfterViewChecked(): void {
    if (this.shouldScroll && this.logStreamEl) {
      const el = this.logStreamEl.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScroll = false;
    }
  }

  loadContainers(): void {
    this.docker.listContainers(true).subscribe(containers => {
      // Stop all existing subs
      this.sources.forEach(s => s.sub?.unsubscribe());

      this.sources = containers.map((c, i) => ({
        id: c.Id,
        name: c.Names[0]?.replace('/', '') ?? c.Id.slice(0, 8),
        color: SOURCE_COLORS[i % SOURCE_COLORS.length],
        on: c.State === 'running',
        count: 0,
      }));

      // Start streaming for running containers
      this.sources.filter(s => s.on).forEach(s => this.startSource(s));
    });
  }

  toggleSource(source: LogSource): void {
    if (source.on) {
      this.startSource(source);
    } else {
      source.sub?.unsubscribe();
      source.sub = undefined;
    }
  }

  private startSource(source: LogSource): void {
    source.sub?.unsubscribe();
    source.sub = this.ws.streamLogs(source.id, '50').subscribe(raw => {
      source.count++;
      this.lineCountThisSecond++;
      if (!this.paused) this.addLine(raw, source);
    });
  }

  private addLine(raw: string, source: LogSource): void {
    const clean = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const level = /\b(WARN|WARNING)\b/i.test(clean) ? 'warn'
                : /\b(ERROR|ERR|FATAL|CRIT)\b/i.test(clean) ? 'err'
                : 'info';
    this.lines.push({ ts, src: source.name, color: source.color, level, msg: clean.trim() });
    if (this.lines.length > 2000) this.lines = this.lines.slice(-2000);
    this.shouldScroll = true;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  clearLines(): void {
    this.lines = [];
    this.sources.forEach(s => s.count = 0);
  }
}
