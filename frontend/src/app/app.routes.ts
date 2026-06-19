import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
  {
    path: 'dashboard',
    loadComponent: () => import('./components/dashboard/dashboard.component').then(m => m.DashboardComponent)
  },
  {
    path: 'containers',
    loadComponent: () => import('./components/containers/container-list/container-list.component').then(m => m.ContainerListComponent)
  },
  { path: 'containers/:id', redirectTo: 'containers', pathMatch: 'full' },
  {
    path: 'images',
    loadComponent: () => import('./components/images/image-list.component').then(m => m.ImageListComponent)
  },
  {
    path: 'networks',
    loadComponent: () => import('./components/networks/network-list.component').then(m => m.NetworkListComponent)
  },
  {
    path: 'volumes',
    loadComponent: () => import('./components/volumes/volume-list.component').then(m => m.VolumeListComponent)
  },
  {
    path: 'stacks',
    loadComponent: () => import('./components/stacks/stack-list.component').then(m => m.StackListComponent)
  },
  {
    path: 'builds',
    loadComponent: () => import('./components/builds/builds.component').then(m => m.BuildsComponent)
  },
  {
    path: 'registry',
    loadComponent: () => import('./components/registry/registry.component').then(m => m.RegistryComponent)
  },
  {
    path: 'logs',
    loadComponent: () => import('./components/logs/logs-page.component').then(m => m.LogsPageComponent)
  },
  {
    path: 'metrics',
    loadComponent: () => import('./components/metrics/metrics.component').then(m => m.MetricsComponent)
  },
  {
    path: 'events',
    loadComponent: () => import('./components/events/events.component').then(m => m.EventsComponent)
  },
  {
    path: 'source',
    loadComponent: () => import('./components/source/source.component').then(m => m.SourceComponent)
  },
  {
    path: 'projects',
    loadComponent: () => import('./components/projects/projects.component').then(m => m.ProjectsComponent)
  },
  {
    path: 'users',
    loadComponent: () => import('./components/users/users.component').then(m => m.UsersComponent)
  },
  {
    path: 'roles',
    loadComponent: () => import('./components/roles/roles.component').then(m => m.RolesComponent)
  },
  {
    path: 'backups',
    loadComponent: () => import('./components/system-backup/system-backup.component').then(m => m.SystemBackupComponent)
  },
  {
    path: 'templates',
    loadComponent: () => import('./components/templates/templates.component').then(m => m.TemplatesComponent)
  },
  {
    path: 'alerts',
    loadComponent: () => import('./components/alerts/alerts.component').then(m => m.AlertsComponent)
  },
  {
    path: 'topology',
    loadComponent: () => import('./components/topology/topology.component').then(m => m.TopologyComponent)
  },
];
