import { Component, OnInit, OnDestroy, HostListener, HostBinding, effect } from '@angular/core';
import { trigger, transition, style, animate } from '@angular/animations';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';
import { Subscription, forkJoin } from 'rxjs';
import { filter } from 'rxjs/operators';
import { IconComponent } from './components/shared/icon/icon.component';
import { StatusDotComponent } from './components/shared/status-dot/status-dot.component';
import { ToastContainerComponent } from './components/shared/toast-container/toast-container.component';
import { CommandPaletteComponent } from './components/shared/command-palette/command-palette.component';
import { ContextMenuComponent } from './components/shared/context-menu/context-menu.component';
import { ConfirmDialogComponent } from './components/shared/confirm-dialog/confirm-dialog.component';
import { DockerService } from './services/docker.service';
import { RealtimeService } from './services/realtime.service';
import { AppEvent, HostStats } from './models/docker.models';
import { AuthComponent } from './auth/auth.component';
import { AuthService } from './auth/auth.service';
import { InstallBannerComponent } from './components/shared/install-banner/install-banner.component';
import { PwaUpdateService } from './services/pwa-update.service';
import { NetworkStatusService } from './services/network-status.service';

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface NavItem {
  label: string;
  icon: string;
  route: string;
  countKey?: keyof NavCounts;
}

interface NavCounts {
  containers: number | null;
  images: number | null;
  volumes: number | null;
  networks: number | null;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet, RouterLink, RouterLinkActive,
    IconComponent, StatusDotComponent, ToastContainerComponent, CommandPaletteComponent,
    ContextMenuComponent, ConfirmDialogComponent, AuthComponent, InstallBannerComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  animations: [
    // Subtle enter slide-fade between routes. `* => *` excludes the initial
    // void state, so the first paint doesn't animate.
    // Opacity-only (no transform): a non-identity transform on .page-body would
    // make it the containing block for its position:fixed descendants (modals,
    // full-screen detail overlays), mis-pinning them mid-transition.
    trigger('routeFade', [
      transition('* => *', [
        style({ opacity: 0 }),
        animate('160ms ease', style({ opacity: 1 })),
      ]),
    ]),
  ],
})
export class AppComponent implements OnInit, OnDestroy {
  // Honour reduced-motion: disables the route transition (and any Angular
  // animation on this view) without affecting CSS.
  @HostBinding('@.disabled') reducedMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  routeKey = '';
  dockerVersion = '';
  engineStatus: 'running' | 'idle' = 'idle';
  paletteOpen = false;
  userMenuOpen = false;
  notifOpen = false;
  sidebarOpen = false;
  notifications: AppEvent[] = [];
  theme: 'dark' | 'light' = 'dark';
  activeSection = '';
  updateAvailable = false;        // drives the "Updates" nav badge (admins only)
  private updateChecked = false;

  navCounts: NavCounts = { containers: null, images: null, volumes: null, networks: null };
  hostStats: HostStats | null = null;

  private sub?: Subscription;
  private countPoll?: Subscription;
  private routeSub?: Subscription;
  private statsPoll?: ReturnType<typeof setInterval>;
  private statsStarted = false;

  navGroups: NavGroup[] = [
    {
      label: 'Overview',
      items: [
        { label: 'Dashboard', icon: 'layout-dashboard', route: '/dashboard' },
        { label: 'Topology',  icon: 'workflow',         route: '/topology'  },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { label: 'Containers', icon: 'box',      route: '/containers', countKey: 'containers' },
        { label: 'Images',     icon: 'layers',   route: '/images',     countKey: 'images'     },
        { label: 'Volumes',    icon: 'database', route: '/volumes',    countKey: 'volumes'    },
        { label: 'Networks',   icon: 'network',  route: '/networks',   countKey: 'networks'   },
      ],
    },
    {
      label: 'Deploy',
      items: [
        { label: 'Templates', icon: 'layout-template', route: '/templates' },
        { label: 'Compose',   icon: 'boxes',           route: '/stacks'    },
        { label: 'Projects',  icon: 'rocket',          route: '/projects'  },
      ],
    },
    {
      label: 'Build',
      items: [
        { label: 'Builds',    icon: 'hammer',      route: '/builds'   },
        { label: 'Git',       icon: 'git-branch',  route: '/source'   },
        { label: 'Registry',  icon: 'cloud',       route: '/registry' },
      ],
    },
    {
      label: 'Observe',
      items: [
        { label: 'Logs',    icon: 'scroll-text', route: '/logs'    },
        { label: 'Metrics', icon: 'activity',    route: '/metrics' },
        { label: 'Events',  icon: 'rss',         route: '/events'  },
        { label: 'Alerts',  icon: 'bell',        route: '/alerts'  },
      ],
    },
  ];

  constructor(
    private docker: DockerService,
    private router: Router,
    public auth: AuthService,
    private realtime: RealtimeService,
    public pwaUpdate: PwaUpdateService,
    public network: NetworkStatusService,
  ) {
    // Once auth resolves an admin, do a one-shot background update check so the
    // sidebar can flag an available update. Errors (incl. non-admin 403) are
    // ignored; the Updates page is the authoritative view.
    effect(() => {
      if (this.auth.ready() && this.auth.authed() && this.auth.isAdmin() && !this.updateChecked) {
        this.updateChecked = true;
        this.docker.checkForUpdate().subscribe({
          next: s => { this.updateAvailable = !!s?.update_available; },
          error: () => { /* ignore */ },
        });
      }
    });

    // Pull host stats (for the status-bar disk readout) as soon as auth resolves,
    // so it doesn't wait a full poll interval to appear.
    effect(() => {
      if (this.auth.ready() && this.auth.authed() && !this.statsStarted) {
        this.statsStarted = true;
        this.loadHostStats();
      }
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      this.paletteOpen = !this.paletteOpen;
    }
    if (event.key === 'Escape') {
      this.paletteOpen = false;
      this.userMenuOpen = false;
      this.notifOpen = false;
      this.closeSidebar();
    }
  }

  toggleSidebar(e: Event): void {
    e.stopPropagation();
    if (this.sidebarOpen) this.closeSidebar(); else this.openSidebar();
  }

  private historyEntryPushed = false;

  openSidebar(): void {
    if (this.sidebarOpen) return;
    this.sidebarOpen = true;
    // Only the mobile drawer needs a back-button entry (the desktop sidebar is
    // always visible). Guard on width, and don't stack entries on rapid re-open.
    if (window.innerWidth <= 820 && !this.historyEntryPushed) {
      history.pushState({ dyOverlay: 'drawer' }, '');
      this.historyEntryPushed = true;
    }
  }

  // fromPop=true → the history entry is already gone (a real back / route change),
  // so just close. fromPop=false (explicit close: backdrop / Esc / toggle) pops
  // our own pushed entry to keep history clean.
  closeSidebar(fromPop = false): void {
    if (!this.sidebarOpen) return;
    this.sidebarOpen = false;
    if (this.historyEntryPushed) {
      this.historyEntryPushed = false;
      if (!fromPop && (history.state as { dyOverlay?: string } | null)?.dyOverlay === 'drawer') {
        history.back();
      }
    }
  }

  @HostListener('window:popstate')
  onPopState(): void {
    if (this.sidebarOpen) this.closeSidebar(true);
    else this.historyEntryPushed = false;
  }

  @HostListener('document:click')
  closeMenus(): void { this.userMenuOpen = false; this.notifOpen = false; }

  toggleUserMenu(e: Event): void { e.stopPropagation(); this.userMenuOpen = !this.userMenuOpen; this.notifOpen = false; }

  logout(): void { this.userMenuOpen = false; this.auth.logout(); }

  toggleNotif(e: Event): void {
    e.stopPropagation();
    this.notifOpen = !this.notifOpen;
    this.userMenuOpen = false;
    if (this.notifOpen) this.loadNotifications();
  }

  private loadNotifications(): void {
    this.docker.getEvents().subscribe({
      next: evs => { this.notifications = (evs || []).slice(0, 8); },
      error: () => { /* leave list as-is */ },
    });
  }

  notifLabel(e: AppEvent): string {
    if (e.message) return e.message;
    const name = e.object_name || e.image || '';
    return name ? `${name} · ${e.kind}` : e.kind;
  }

  notifAgo(ts: string): string {
    if (!ts) return '';
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
  }

  get userInitials(): string {
    const u = this.auth.user();
    const s = (u?.full_name || u?.username || 'DY').trim();
    const parts = s.split(/\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : s.slice(0, 2)).toUpperCase();
  }

  toggleTheme(): void {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('dy_theme', this.theme);
    this.applyTheme();
  }

  private applyTheme(): void {
    if (this.theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    this.syncThemeColor();
  }

  // Keep the PWA chrome (browser theme-color + iOS status bar) in step with the
  // *explicitly chosen* theme. The static prefers-color-scheme metas only track
  // the OS theme, so without this a manual light/dark pick would mismatch — e.g.
  // light-theme status-bar glyphs becoming invisible on a light background.
  private syncThemeColor(): void {
    const dark = this.theme !== 'light';
    // Update a single dedicated meta in place (last matching theme-color wins),
    // leaving the static prefers-color-scheme metas in index.html intact so the
    // OS theme still tracks before this runs and when no explicit choice is made.
    let meta = document.querySelector<HTMLMetaElement>('meta#theme-color-dyn');
    if (!meta) {
      meta = document.createElement('meta');
      meta.id = 'theme-color-dyn';
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = dark ? '#05070C' : '#F6F8FB';
    const bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    // black-translucent only while dark (content draws under the bar); light theme
    // needs the opaque `default` style or the status-bar glyphs vanish. (iOS only
    // re-reads this on next launch.)
    bar?.setAttribute('content', dark ? 'black-translucent' : 'default');
  }

  /** Apply a downloaded service-worker update (user-initiated from the banner). */
  applyUpdate(): void { this.pwaUpdate.applyUpdate(); }

  ngOnInit(): void {
    const storedTheme = localStorage.getItem('dy_theme') as 'dark' | 'light' | null;
    // Default to the OS preference until the user explicitly picks a theme.
    this.theme = storedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    this.applyTheme();
    this.auth.init();
    this.pwaUpdate.init();
    this.sub = this.docker.getSystemInfo().subscribe({
      next: info => {
        this.dockerVersion = info.ServerVersion ?? '';
        this.engineStatus = 'running';
      },
      error: () => {
        this.engineStatus = 'idle';
      },
    });
    this.refreshCounts();
    // Sidebar counts refresh on any container/image/volume/network change (plus
    // a resync on (re)connect / tab refocus), replacing the old 15s poll.
    this.countPoll = this.realtime.changes(['container', 'image', 'volume', 'network'])
      .subscribe(() => this.refreshCounts());
    // Refresh the status-bar disk readout periodically (capacity moves slowly).
    this.statsPoll = setInterval(() => this.loadHostStats(), 60000);
    this.routeKey = this.router.url; // seed so the very first route doesn't fade in
    this.activeSection = this.sectionFromUrl(this.router.url);
    this.routeSub = this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe(e => {
      this.routeKey = (e as NavigationEnd).urlAfterRedirects || (e as NavigationEnd).url;
      this.activeSection = this.sectionFromUrl(this.routeKey);
      this.closeSidebar(true); // dismiss the mobile drawer after navigating (the nav entry buried ours)
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.countPoll?.unsubscribe();
    this.routeSub?.unsubscribe();
    if (this.statsPoll) clearInterval(this.statsPoll);
  }

  private loadHostStats(): void {
    if (!this.auth.authed()) return;
    this.docker.getHostStats().subscribe({
      next: s => { this.hostStats = s; },
      error: () => { /* leave last reading; status bar just omits disk */ },
    });
  }

  // Host disk used / total for the status bar, e.g. "412 GB / 460 GB".
  get diskLabel(): string {
    const s = this.hostStats;
    if (!s?.disk_total) return '';
    return `${this.fmtSize(s.disk_used)} / ${this.fmtSize(s.disk_total)}`;
  }

  private fmtSize(bytes: number): string {
    const tb = bytes / (1024 ** 4);
    if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
    return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
  }

  private sectionFromUrl(url: string): string {
    const map: Record<string, string> = {
      '/containers': 'Containers',
      '/images': 'Images',
      '/volumes': 'Volumes',
      '/networks': 'Networks',
      '/stacks': 'Compose',
      '/builds': 'Builds',
      '/source': 'Git',
      '/registry': 'Registry',
      '/templates': 'Templates',
      '/projects': 'Projects',
      '/dashboard': 'Dashboard',
      '/topology': 'Topology',
      '/logs': 'Logs',
      '/metrics': 'Metrics',
      '/events': 'Events',
      '/alerts': 'Alerts',
      '/users': 'Users',
      '/roles': 'Roles',
      '/backups': 'Backups',
      '/updates': 'Updates',
    };
    for (const [path, label] of Object.entries(map)) {
      if (url.startsWith(path)) return label;
    }
    return '';
  }

  private refreshCounts(): void {
    this.docker.listContainers(true).subscribe(c => this.navCounts.containers = c.length);
    this.docker.listImages().subscribe(i => this.navCounts.images = i.length);
    this.docker.listVolumes().subscribe(v => this.navCounts.volumes = v.Volumes?.length ?? 0);
    this.docker.listNetworks().subscribe(n => this.navCounts.networks = n.length);
  }
}

