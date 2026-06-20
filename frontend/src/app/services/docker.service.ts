import { Injectable } from '@angular/core';
import { HttpClient, HttpEvent, HttpParams, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { VEntry, VFilePreview, VUsage, VolumeBackup, BackupSchedule } from '../components/volumes/volume-explorer.data';
import {
  ContainerSummary, ContainerInspect, ContainerStats,
  ImageSummary, NetworkResource, VolumeListResponse, VolumeSummary,
  SystemInfo, DiskUsage, HostStats, AppEvent, WatchedImage,
  StackSummary, StackDetail, Build, BuildDefinition, RegistryItem, RegistryImage,
  GitRepo, GitFileStatus, GitCommit, GitBranch,
  Project, ProjectLogs, ProjectFileNode, ProjectPortCheck,
  UpdateStatus, EventFilter
} from '../models/docker.models';
import { map } from 'rxjs/operators';

export interface MetricSample {
  ts: string;
  cpu_pct: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

export interface AlertRule {
  id: number;
  name: string;
  type: string;
  threshold: number;
  channel: string;
  webhook_url: string;
  enabled: boolean;
  for_seconds?: number;  // condition must hold this long before firing (0 = immediate)
  firing?: boolean;      // runtime: currently in a fired (unresolved) state
  created_at?: string;
}

export interface StackEnvVar {
  key: string;
  value: string;
  is_secret: boolean;
}

export interface StackDeploy {
  id: number;
  stack_name: string;
  content: string;
  created_at: string;
}

export interface AppBackup {
  name: string;
  size_bytes: number;
  created_at: string;
  secret_included: boolean;
}

export interface AppBackupSchedule {
  enabled: boolean;
  interval_hours: number;
  keep: number;
  last_run_at: string | null;
  updated_at: string;
}

export interface BkpDest { id: string; label: string; icon: string; bytes: number; }
export interface BkpPolicy {
  id: string; kind: 'volume' | 'app'; target: string; icon: string; type: string;
  cadence: string; dest: string; retention: string; next: string; enabled: boolean;
  interval_hours: number; keep: number; stop_container: boolean;
}
export interface BkpHistory {
  id: string; kind: 'volume' | 'app'; target: string; type: string; size_bytes: number;
  dest: string; started_at: string; status: string;
  volume_name?: string; backup_id?: number; name?: string;
}
export interface BkpStats {
  protected_volumes: number; total_volumes: number; storage_bytes: number;
  last_backup_at: string | null; last_backup_target: string;
  next_scheduled_at: string | null; next_scheduled_target: string;
}
export interface BackupsOverview {
  configured: boolean; key_external: boolean; stats: BkpStats;
  destinations: BkpDest[]; policies: BkpPolicy[]; recent: BkpHistory[];
}

@Injectable({ providedIn: 'root' })
export class DockerService {
  private base = '/api/v1';

  constructor(private http: HttpClient) {}

  // ---- System ----------------------------------------------------------------
  getSystemInfo(): Observable<SystemInfo> {
    return this.http.get<SystemInfo>(`${this.base}/system/info`);
  }

  getSystemVersion(): Observable<any> {
    return this.http.get<any>(`${this.base}/system/version`);
  }

  getDiskUsage(): Observable<DiskUsage> {
    return this.http.get<DiskUsage>(`${this.base}/system/df`);
  }

  getHostStats(): Observable<HostStats> {
    return this.http.get<HostStats>(`${this.base}/system/host-stats`);
  }

  getMetricsHistory(rangeSec = 3600): Observable<MetricSample[]> {
    const params = new HttpParams().set('range', String(rangeSec));
    return this.http.get<MetricSample[]>(`${this.base}/system/metrics-history`, { params });
  }

  // ---- Self-update -----------------------------------------------------------
  checkForUpdate(force = false): Observable<UpdateStatus> {
    const params = force ? new HttpParams().set('force', 'true') : undefined;
    return this.http.get<UpdateStatus>(`${this.base}/system/update/check`, { params });
  }

  applyUpdate(): Observable<{ status: string; updater: string; backup?: string }> {
    return this.http.post<{ status: string; updater: string; backup?: string }>(`${this.base}/system/update/apply`, {});
  }

  getUpdateLogs(): Observable<{ exists: boolean; state?: string; logs: string }> {
    return this.http.get<{ exists: boolean; state?: string; logs: string }>(`${this.base}/system/update/logs`);
  }

  // ---- Alerts ----------------------------------------------------------------
  listAlerts(): Observable<AlertRule[]> {
    return this.http.get<AlertRule[]>(`${this.base}/alerts`);
  }
  createAlert(a: Partial<AlertRule>): Observable<AlertRule> {
    return this.http.post<AlertRule>(`${this.base}/alerts`, a);
  }
  updateAlert(id: number, a: Partial<AlertRule>): Observable<AlertRule> {
    return this.http.put<AlertRule>(`${this.base}/alerts/${id}`, a);
  }
  deleteAlert(id: number): Observable<any> {
    return this.http.delete(`${this.base}/alerts/${id}`);
  }

  // ---- Containers ------------------------------------------------------------
  listContainers(all = true): Observable<ContainerSummary[]> {
    const params = new HttpParams().set('all', String(all));
    return this.http.get<ContainerSummary[]>(`${this.base}/containers`, { params });
  }

  inspectContainer(id: string): Observable<ContainerInspect> {
    return this.http.get<ContainerInspect>(`${this.base}/containers/${id}`);
  }

  startContainer(id: string): Observable<any> {
    return this.http.post(`${this.base}/containers/${id}/start`, null);
  }

  stopContainer(id: string, timeout = 10): Observable<any> {
    const params = new HttpParams().set('timeout', String(timeout));
    return this.http.post(`${this.base}/containers/${id}/stop`, null, { params });
  }

  restartContainer(id: string): Observable<any> {
    return this.http.post(`${this.base}/containers/${id}/restart`, null);
  }

  pauseContainer(id: string): Observable<any> {
    return this.http.post(`${this.base}/containers/${id}/pause`, null);
  }

  unpauseContainer(id: string): Observable<any> {
    return this.http.post(`${this.base}/containers/${id}/unpause`, null);
  }

  removeContainer(id: string, force = false, volumes = false): Observable<any> {
    const params = new HttpParams()
      .set('force', String(force))
      .set('volumes', String(volumes));
    return this.http.delete(`${this.base}/containers/${id}`, { params });
  }

  renameContainer(id: string, name: string): Observable<any> {
    return this.http.post(`${this.base}/containers/${id}/rename`, { name });
  }

  updateContainerResources(id: string, body: { cpus: number; memory_mb: number; restart_policy: string }): Observable<any> {
    return this.http.post(`${this.base}/containers/${id}/update`, body);
  }

  getContainerLogs(id: string, tail = '100', timestamps = false): Observable<string> {
    const params = new HttpParams()
      .set('tail', tail)
      .set('timestamps', String(timestamps));
    return this.http.get(`${this.base}/containers/${id}/logs`, { params, responseType: 'text' });
  }

  getContainerStats(id: string): Observable<ContainerStats> {
    return this.http.get<ContainerStats>(`${this.base}/containers/${id}/stats`);
  }

  getContainerTop(id: string): Observable<any> {
    return this.http.get<any>(`${this.base}/containers/${id}/top`);
  }

  execContainer(id: string, cmd: string[]): Observable<string> {
    return this.http.post(`${this.base}/containers/${id}/exec`, { cmd }, { responseType: 'text' });
  }

  pruneContainers(): Observable<any> {
    return this.http.delete(`${this.base}/containers`);
  }

  // ---- Images ----------------------------------------------------------------
  listImages(): Observable<ImageSummary[]> {
    return this.http.get<ImageSummary[]>(`${this.base}/images`);
  }

  inspectImage(id: string): Observable<any> {
    return this.http.get<any>(`${this.base}/images/${id}`);
  }

  pullImage(image: string): Observable<string> {
    return this.http.post(`${this.base}/images/pull`, { image }, { responseType: 'text' });
  }

  removeImage(id: string, force = false): Observable<any> {
    const params = new HttpParams().set('force', String(force));
    return this.http.delete(`${this.base}/images/${id}`, { params });
  }

  tagImage(id: string, tag: string): Observable<any> {
    return this.http.post(`${this.base}/images/${id}/tag`, { tag });
  }

  getImageHistory(id: string): Observable<any[]> {
    return this.http.get<any[]>(`${this.base}/images/${id}/history`);
  }

  pruneImages(dangling = true): Observable<any> {
    const params = new HttpParams().set('dangling', String(dangling));
    return this.http.delete(`${this.base}/images/prune`, { params });
  }

  searchImages(q: string): Observable<any[]> {
    const params = new HttpParams().set('q', q);
    return this.http.get<any[]>(`${this.base}/images/search`, { params });
  }

  // ---- Networks --------------------------------------------------------------
  listNetworks(): Observable<NetworkResource[]> {
    return this.http.get<NetworkResource[]>(`${this.base}/networks`);
  }

  inspectNetwork(id: string): Observable<NetworkResource> {
    return this.http.get<NetworkResource>(`${this.base}/networks/${id}`);
  }

  createNetwork(body: { name: string; driver?: string; internal?: boolean; enable_ipv6?: boolean }): Observable<any> {
    return this.http.post(`${this.base}/networks`, body);
  }

  removeNetwork(id: string): Observable<any> {
    return this.http.delete(`${this.base}/networks/${id}`);
  }

  connectNetwork(id: string, container_id: string): Observable<any> {
    return this.http.post(`${this.base}/networks/${id}/connect`, { container_id });
  }

  disconnectNetwork(id: string, container_id: string, force = false): Observable<any> {
    return this.http.post(`${this.base}/networks/${id}/disconnect`, { container_id, force });
  }

  pruneNetworks(): Observable<any> {
    return this.http.delete(`${this.base}/networks/prune`);
  }

  // ---- Volumes ---------------------------------------------------------------
  listVolumes(): Observable<VolumeListResponse> {
    return this.http.get<VolumeListResponse>(`${this.base}/volumes`);
  }

  inspectVolume(name: string): Observable<VolumeSummary> {
    return this.http.get<VolumeSummary>(`${this.base}/volumes/${name}`);
  }

  createVolume(body: { Name?: string; Driver?: string; Labels?: Record<string, string> }): Observable<VolumeSummary> {
    return this.http.post<VolumeSummary>(`${this.base}/volumes`, body);
  }

  removeVolume(name: string, force = false): Observable<any> {
    const params = new HttpParams().set('force', String(force));
    return this.http.delete(`${this.base}/volumes/${name}`, { params });
  }

  pruneVolumes(): Observable<any> {
    return this.http.delete(`${this.base}/volumes/prune`);
  }

  // ---- Volume file browser ---------------------------------------------------
  listVolumeFiles(name: string, path = ''): Observable<{ path: string; entries: VEntry[] }> {
    const params = new HttpParams().set('path', path);
    return this.http.get<{ path: string; entries: VEntry[] }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/files`, { params });
  }

  searchVolumeFiles(name: string, q: string): Observable<{ entries: VEntry[] }> {
    const params = new HttpParams().set('q', q);
    return this.http.get<{ entries: VEntry[] }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/search`, { params });
  }

  getVolumeFilePreview(name: string, path: string): Observable<VFilePreview> {
    const params = new HttpParams().set('path', path);
    return this.http.get<VFilePreview>(
      `${this.base}/volumes/${encodeURIComponent(name)}/file`, { params });
  }

  getVolumeUsage(name: string): Observable<VUsage> {
    return this.http.get<VUsage>(`${this.base}/volumes/${encodeURIComponent(name)}/usage`);
  }

  /** Download a file (raw) or directory (tar) from a volume as a Blob. */
  downloadVolumePath(name: string, path: string): Observable<HttpResponse<Blob>> {
    const params = new HttpParams().set('path', path);
    return this.http.get(`${this.base}/volumes/${encodeURIComponent(name)}/download`, {
      params, responseType: 'blob', observe: 'response',
    });
  }

  // ---- Volume backup / restore ----------------------------------------------
  listVolumeBackups(name: string): Observable<{ configured: boolean; backups: VolumeBackup[] }> {
    return this.http.get<{ configured: boolean; backups: VolumeBackup[] }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/backups`);
  }

  createVolumeBackup(name: string, body: { stop_container: boolean; note: string }): Observable<VolumeBackup> {
    return this.http.post<VolumeBackup>(`${this.base}/volumes/${encodeURIComponent(name)}/backups`, body);
  }

  restoreVolumeBackup(name: string, id: number, targetVolume?: string): Observable<{ status: string }> {
    const body = targetVolume ? { target_volume: targetVolume } : null;
    return this.http.post<{ status: string }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/backups/${id}/restore`, body);
  }

  deleteVolumeBackup(name: string, id: number): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/backups/${id}`);
  }

  downloadVolumeBackup(name: string, id: number): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.base}/volumes/${encodeURIComponent(name)}/backups/${id}/download`, {
      responseType: 'blob', observe: 'response',
    });
  }

  getBackupSchedule(name: string): Observable<{ configured: boolean; schedule: BackupSchedule }> {
    return this.http.get<{ configured: boolean; schedule: BackupSchedule }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/backup-schedule`);
  }

  setBackupSchedule(name: string, body: { enabled: boolean; interval_hours: number; keep: number; stop_container: boolean }):
    Observable<{ configured: boolean; schedule: BackupSchedule }> {
    return this.http.put<{ configured: boolean; schedule: BackupSchedule }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/backup-schedule`, body);
  }

  deleteBackupSchedule(name: string): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(
      `${this.base}/volumes/${encodeURIComponent(name)}/backup-schedule`);
  }

  // ---- Application (system) backup -------------------------------------------
  getBackupsOverview(): Observable<BackupsOverview> {
    return this.http.get<BackupsOverview>(`${this.base}/system/backups/overview`);
  }

  listAppBackups(): Observable<{ configured: boolean; key_external: boolean; backups: AppBackup[] }> {
    return this.http.get<{ configured: boolean; key_external: boolean; backups: AppBackup[] }>(
      `${this.base}/system/backups`);
  }

  createAppBackup(): Observable<AppBackup> {
    return this.http.post<AppBackup>(`${this.base}/system/backups`, null);
  }

  deleteAppBackup(name: string): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(`${this.base}/system/backups/${encodeURIComponent(name)}`);
  }

  downloadAppBackup(name: string): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.base}/system/backups/${encodeURIComponent(name)}/download`, {
      responseType: 'blob', observe: 'response',
    });
  }

  getAppBackupSchedule(): Observable<{ configured: boolean; schedule: AppBackupSchedule }> {
    return this.http.get<{ configured: boolean; schedule: AppBackupSchedule }>(`${this.base}/system/backup-schedule`);
  }

  setAppBackupSchedule(body: { enabled: boolean; interval_hours: number; keep: number }):
    Observable<{ configured: boolean; schedule: AppBackupSchedule }> {
    return this.http.put<{ configured: boolean; schedule: AppBackupSchedule }>(`${this.base}/system/backup-schedule`, body);
  }

  // ---- Events ----------------------------------------------------------------
  getEvents(kind?: string): Observable<AppEvent[]> {
    let params = new HttpParams();
    if (kind) params = params.set('kind', kind);
    return this.http.get<AppEvent[]>(`${this.base}/events`, { params });
  }

  // Events plus the count of entries hidden by mute rules (read from a response
  // header so the body keeps its plain-array shape). includeMuted returns muted
  // events too, for the "show muted" toggle.
  getEventsWithMeta(kind?: string, includeMuted = false): Observable<{ events: AppEvent[]; muted: number }> {
    let params = new HttpParams();
    if (kind) params = params.set('kind', kind);
    if (includeMuted) params = params.set('include_muted', 'true');
    return this.http.get<AppEvent[]>(`${this.base}/events`, { params, observe: 'response' }).pipe(
      map(resp => ({
        events: resp.body ?? [],
        muted: Number(resp.headers.get('X-Events-Muted-Count') ?? 0),
      })),
    );
  }

  // ---- Event mute rules ------------------------------------------------------
  getEventFilters(): Observable<EventFilter[]> {
    return this.http.get<EventFilter[]>(`${this.base}/events/filters`);
  }
  createEventFilter(object_name: string, kind: string): Observable<EventFilter> {
    return this.http.post<EventFilter>(`${this.base}/events/filters`, { object_name, kind });
  }
  setEventFilterEnabled(id: number, enabled: boolean): Observable<unknown> {
    return this.http.patch(`${this.base}/events/filters/${id}`, { enabled });
  }
  deleteEventFilter(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/events/filters/${id}`);
  }

  // ---- Watcher ---------------------------------------------------------------
  getWatchedImages(): Observable<WatchedImage[]> {
    return this.http.get<WatchedImage[]>(`${this.base}/watcher`);
  }

  upsertWatchedImage(w: WatchedImage): Observable<any> {
    return this.http.post(`${this.base}/watcher`, w);
  }

  deleteWatchedImage(container_id: string): Observable<any> {
    const params = new HttpParams().set('container_id', container_id);
    return this.http.delete(`${this.base}/watcher`, { params });
  }

  triggerWatcherCheck(): Observable<any> {
    return this.http.post(`${this.base}/watcher/check`, null);
  }

  // Synchronously re-check one container's image and return the refreshed record.
  checkWatchedImage(container_id: string): Observable<WatchedImage> {
    const params = new HttpParams().set('container_id', container_id);
    return this.http.post<WatchedImage>(`${this.base}/watcher/check`, null, { params });
  }

  // Pull the latest image and recreate the container now (its ID changes).
  updateWatchedImage(container_id: string): Observable<any> {
    const params = new HttpParams().set('container_id', container_id);
    return this.http.post(`${this.base}/watcher/update`, null, { params });
  }

  // ---- Stacks ----------------------------------------------------------------
  listStacks(): Observable<StackSummary[]> {
    return this.http.get<StackSummary[]>(`${this.base}/stacks`);
  }

  getStack(name: string): Observable<StackDetail> {
    return this.http.get<StackDetail>(`${this.base}/stacks/${name}`);
  }

  deployStack(name: string, content: string): Observable<any> {
    return this.http.post(`${this.base}/stacks`, { name, content });
  }

  getStackEnv(name: string): Observable<StackEnvVar[]> {
    return this.http.get<StackEnvVar[]>(`${this.base}/stacks/${name}/env`);
  }
  setStackEnv(name: string, vars: StackEnvVar[]): Observable<any> {
    return this.http.put(`${this.base}/stacks/${name}/env`, vars);
  }

  getDeployHook(id: number): Observable<{ enabled: boolean; path?: string }> {
    return this.http.get<{ enabled: boolean; path?: string }>(`${this.base}/projects/${id}/deploy-hook`);
  }
  enableDeployHook(id: number): Observable<{ enabled: boolean; path: string }> {
    return this.http.post<{ enabled: boolean; path: string }>(`${this.base}/projects/${id}/deploy-hook`, null);
  }
  disableDeployHook(id: number): Observable<unknown> {
    return this.http.delete(`${this.base}/projects/${id}/deploy-hook`);
  }

  getStackHistory(name: string): Observable<StackDeploy[]> {
    return this.http.get<StackDeploy[]>(`${this.base}/stacks/${name}/history`);
  }
  rollbackStack(name: string, deployId: number): Observable<any> {
    return this.http.post(`${this.base}/stacks/${name}/rollback/${deployId}`, null);
  }

  updateStack(name: string, content: string): Observable<any> {
    return this.http.put(`${this.base}/stacks/${name}`, { content });
  }

  stackAction(name: string, action: 'start' | 'stop' | 'restart' | 'pull' | 'up' | 'down'): Observable<any> {
    return this.http.post(`${this.base}/stacks/${name}/${action}`, null);
  }

  removeStack(name: string, removeVolumes = false): Observable<any> {
    const params = new HttpParams().set('volumes', String(removeVolumes));
    return this.http.delete(`${this.base}/stacks/${name}`, { params });
  }

  getStackLogs(name: string, tail = '100'): Observable<string> {
    const params = new HttpParams().set('tail', tail);
    return this.http.get(`${this.base}/stacks/${name}/logs`, { params, responseType: 'text' });
  }

  // ---- Builds ----------------------------------------------------------------
  listBuilds(): Observable<Build[]> {
    return this.http.get<Build[]>(`${this.base}/builds`);
  }

  getBuild(id: string): Observable<Build> {
    return this.http.get<Build>(`${this.base}/builds/${id}`);
  }

  submitBuild(payload: {
    name: string;
    tag: string;
    dockerfile: string;
    push_to_registry?: boolean;
    registry_url?: string;
    initiated_by?: string;
  }): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/builds`, payload);
  }

  cancelBuild(id: string): Observable<any> {
    return this.http.post(`${this.base}/builds/${id}/cancel`, null);
  }

  clearBuildCache(): Observable<any> {
    return this.http.post(`${this.base}/builds/cache/clear`, null);
  }

  // ---- Build definitions ----------------------------------------------------
  listDefinitions(): Observable<BuildDefinition[]> {
    return this.http.get<BuildDefinition[]>(`${this.base}/builds/definitions`);
  }

  getDefinition(id: string): Observable<BuildDefinition> {
    return this.http.get<BuildDefinition>(`${this.base}/builds/definitions/${id}`);
  }

  createDefinition(def: Partial<BuildDefinition>): Observable<BuildDefinition> {
    return this.http.post<BuildDefinition>(`${this.base}/builds/definitions`, def);
  }

  updateDefinition(id: string, def: Partial<BuildDefinition>): Observable<BuildDefinition> {
    return this.http.put<BuildDefinition>(`${this.base}/builds/definitions/${id}`, def);
  }

  deleteDefinition(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/builds/definitions/${id}`);
  }

  runDefinition(id: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/builds/definitions/${id}/run`, null);
  }

  listDefinitionRuns(id: string): Observable<Build[]> {
    return this.http.get<Build[]>(`${this.base}/builds/definitions/${id}/runs`);
  }

  // ---- Registries ------------------------------------------------------------
  listRegistries(): Observable<RegistryItem[]> {
    return this.http.get<RegistryItem[]>(`${this.base}/registries`);
  }

  addRegistry(payload: {
    name?: string;
    url: string;
    type?: string;
    username?: string;
    password?: string;
  }): Observable<any> {
    return this.http.post(`${this.base}/registries`, payload);
  }

  removeRegistry(id: number): Observable<any> {
    return this.http.delete(`${this.base}/registries/${id}`);
  }

  listInternalImages(): Observable<RegistryImage[]> {
    return this.http.get<RegistryImage[]>(`${this.base}/registries/internal/images`);
  }

  // ---- Git source control ---------------------------------------------------
  listGitRepos(): Observable<GitRepo[]> {
    return this.http.get<GitRepo[]>(`${this.base}/git/repos`);
  }

  addGitRepo(payload: {
    name: string;
    path?: string;
    clone_url?: string;
    username?: string;
    token?: string;
    author_name?: string;
    author_email?: string;
    description?: string;
  }): Observable<GitRepo> {
    return this.http.post<GitRepo>(`${this.base}/git/repos`, payload);
  }

  removeGitRepo(id: number, deleteFiles = false): Observable<void> {
    const params = new HttpParams().set('delete_files', String(deleteFiles));
    return this.http.delete<void>(`${this.base}/git/repos/${id}`, { params });
  }

  getGitStatus(id: number): Observable<GitFileStatus[]> {
    return this.http.get<GitFileStatus[]>(`${this.base}/git/repos/${id}/status`);
  }

  stageFiles(id: number, files: string[]): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/stage`, { files });
  }

  unstageFiles(id: number, files: string[]): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/unstage`, { files });
  }

  gitCommit(id: number, message: string, authorName?: string, authorEmail?: string): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/commit`, {
      message,
      author_name: authorName ?? '',
      author_email: authorEmail ?? '',
    });
  }

  gitPush(id: number, force = false): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/push`, { force });
  }

  gitPull(id: number): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/pull`, {});
  }

  gitFetch(id: number): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/fetch`, {});
  }

  getGitBranches(id: number): Observable<GitBranch[]> {
    return this.http.get<GitBranch[]>(`${this.base}/git/repos/${id}/branches`);
  }

  gitCheckout(id: number, branch: string, create = false): Observable<any> {
    return this.http.post(`${this.base}/git/repos/${id}/checkout`, { branch, create });
  }

  getGitLog(id: number, limit = 50): Observable<GitCommit[]> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http.get<GitCommit[]>(`${this.base}/git/repos/${id}/log`, { params });
  }

  getGitDiff(id: number, file?: string, staged = false): Observable<{ diff: string }> {
    let params = new HttpParams().set('staged', String(staged));
    if (file) params = params.set('file', file);
    return this.http.get<{ diff: string }>(`${this.base}/git/repos/${id}/diff`, { params });
  }
  getGitRepo(id: number): Observable<GitRepo> {
    return this.http.get<GitRepo>(`${this.base}/git/repos/${id}`);
  }

  updateGitRepo(id: number, data: { author_name: string; author_email: string }): Observable<GitRepo> {
    return this.http.patch<GitRepo>(`${this.base}/git/repos/${id}`, data);
  }
  // ── Projects ────────────────────────────────────────────────────────────────

  uploadProject(
    payload: File | { file: File; path: string }[],
    name: string,
    description: string,
    ports: string
  ): Observable<HttpEvent<Project>> {
    const fd = new FormData();
    if (payload instanceof File) {
      fd.append('archive', payload);
    } else {
      for (const { file, path } of payload) {
        fd.append('files', file, path);
      }
    }
    fd.append('name', name);
    fd.append('description', description);
    fd.append('ports', ports);
    return this.http.post<Project>(`${this.base}/projects`, fd, {
      reportProgress: true,
      observe: 'events'
    });
  }

  updateProjectPorts(id: number, ports: string): Observable<Project> {
    return this.http.patch<Project>(`${this.base}/projects/${id}/ports`, { ports });
  }

  overrideProjectPort(id: number, oldPort: string, newPort: string): Observable<{status: string}> {
    return this.http.patch<{status: string}>(`${this.base}/projects/${id}/port-override`, { old_port: oldPort, new_port: newPort });
  }

  // Checks whether any of the project's declared host ports are already bound by
  // another running container, so the UI can warn before a build/run.
  checkProjectPorts(id: number): Observable<ProjectPortCheck> {
    return this.http.get<ProjectPortCheck>(`${this.base}/projects/${id}/port-check`);
  }

  listProjects(): Observable<Project[]> {
    return this.http.get<Project[]>(`${this.base}/projects`);
  }

  getProject(id: number): Observable<Project> {
    return this.http.get<Project>(`${this.base}/projects/${id}`);
  }

  deleteProject(id: number, purge = false): Observable<void> {
    const qs = purge ? '?purge=true' : '';
    return this.http.delete<void>(`${this.base}/projects/${id}${qs}`);
  }

  // noCache=true forces a full rebuild that ignores Docker's layer cache.
  buildProject(id: number, noCache = false): Observable<any> {
    const q = noCache ? '?no_cache=true' : '';
    return this.http.post(`${this.base}/projects/${id}/build${q}`, {});
  }

  runProject(id: number, noCache = false): Observable<any> {
    const q = noCache ? '?no_cache=true' : '';
    return this.http.post(`${this.base}/projects/${id}/run${q}`, {});
  }

  restartProject(id: number): Observable<any> {
    return this.http.post(`${this.base}/projects/${id}/restart`, {});
  }

  stopProject(id: number): Observable<any> {
    return this.http.post(`${this.base}/projects/${id}/stop`, {});
  }

  getProjectLogs(id: number): Observable<ProjectLogs> {
    return this.http.get<ProjectLogs>(`${this.base}/projects/${id}/logs`);
  }

  getProjectFiles(id: number): Observable<ProjectFileNode[]> {
    return this.http.get<ProjectFileNode[]>(`${this.base}/projects/${id}/files`);
  }

  getProjectFileContent(id: number, path: string): Observable<string> {
    return this.http.get(`${this.base}/projects/${id}/file`, {
      params: { path },
      responseType: 'text',
    });
  }

  initProjectRepo(id: number): Observable<GitRepo> {
    return this.http.post<GitRepo>(`${this.base}/projects/${id}/repo/init`, {});
  }
}
