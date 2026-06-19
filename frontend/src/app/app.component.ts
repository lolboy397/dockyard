import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
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
import { AppEvent } from './models/docker.models';
import { AuthComponent } from './auth/auth.component';
import { AuthService } from './auth/auth.service';

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
    ContextMenuComponent, ConfirmDialogComponent, AuthComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  dockerVersion = '';
  engineStatus: 'running' | 'idle' = 'idle';
  paletteOpen = false;
  userMenuOpen = false;
  notifOpen = false;
  sidebarOpen = false;
  notifications: AppEvent[] = [];
  theme: 'dark' | 'light' = 'dark';
  activeSection = '';

  navCounts: NavCounts = { containers: null, images: null, volumes: null, networks: null };

  private sub?: Subscription;
  private countPoll?: Subscription;
  private routeSub?: Subscription;

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

  constructor(private docker: DockerService, private router: Router, public auth: AuthService, private realtime: RealtimeService) {}

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
      this.sidebarOpen = false;
    }
  }

  toggleSidebar(e: Event): void { e.stopPropagation(); this.sidebarOpen = !this.sidebarOpen; }

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
  }

  ngOnInit(): void {
    const storedTheme = localStorage.getItem('dy_theme') as 'dark' | 'light' | null;
    // Default to the OS preference until the user explicitly picks a theme.
    this.theme = storedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    this.applyTheme();
    this.auth.init();
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
    this.activeSection = this.sectionFromUrl(this.router.url);
    this.routeSub = this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe(e => {
      this.activeSection = this.sectionFromUrl((e as NavigationEnd).urlAfterRedirects || (e as NavigationEnd).url);
      this.sidebarOpen = false; // dismiss the mobile drawer after navigating
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.countPoll?.unsubscribe();
    this.routeSub?.unsubscribe();
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

