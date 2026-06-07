export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  State: string;
  Status: string;
  Ports: Port[];
  Labels: Record<string, string>;
  NetworkSettings: { Networks: Record<string, any> };
  Mounts: Mount[];
  SizeRw?: number;
  SizeRootFs?: number;
}

export interface Port {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

export interface Mount {
  Type: string;
  Name?: string;
  Source: string;
  Destination: string;
  Mode: string;
  RW: boolean;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  State: ContainerState;
  Image: string;
  Config: ContainerConfig;
  HostConfig: HostConfig;
  NetworkSettings: any;
  Mounts: Mount[];
}

export interface ContainerState {
  Status: string;
  Running: boolean;
  Paused: boolean;
  Restarting: boolean;
  Dead: boolean;
  Pid: number;
  ExitCode: number;
  StartedAt: string;
  FinishedAt: string;
}

export interface ContainerConfig {
  Image: string;
  Cmd: string[];
  Env: string[];
  Labels: Record<string, string>;
  ExposedPorts: Record<string, any>;
  WorkingDir: string;
  Entrypoint: string[];
}

export interface HostConfig {
  Binds: string[];
  PortBindings: Record<string, any>;
  RestartPolicy: { Name: string; MaximumRetryCount: number };
  NetworkMode: string;
  Privileged: boolean;
  Memory: number;
  CpuShares: number;
}

export interface ContainerStats {
  cpu_stats: CpuStats;
  precpu_stats: CpuStats;
  memory_stats: MemoryStats;
  networks: Record<string, NetworkStats>;
  blkio_stats: BlkioStats;
  read: string;
}

export interface CpuStats {
  cpu_usage: { total_usage: number; percpu_usage: number[] };
  system_cpu_usage: number;
  online_cpus: number;
}

export interface MemoryStats {
  usage: number;
  limit: number;
  stats: Record<string, number>;
}

export interface NetworkStats {
  rx_bytes: number;
  tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
}

export interface BlkioStats {
  io_service_bytes_recursive: { op: string; value: number }[];
}

export interface ImageSummary {
  Id: string;
  ParentId: string;
  RepoTags: string[];
  RepoDigests: string[];
  Created: number;
  Size: number;
  VirtualSize: number;
  Labels: Record<string, string>;
  Containers: number;
}

export interface NetworkResource {
  Id: string;
  Name: string;
  Driver: string;
  Scope: string;
  EnableIPv6: boolean;
  Internal: boolean;
  Attachable: boolean;
  IPAM: { Driver: string; Config: { Subnet: string; Gateway: string }[] };
  Containers: Record<string, { Name: string; EndpointID: string; MacAddress: string; IPv4Address: string; IPv6Address: string }>;
  Labels: Record<string, string>;
  Created: string;
}

export interface VolumeListResponse {
  Volumes: VolumeSummary[];
  Warnings: string[];
}

export interface VolumeSummary {
  Name: string;
  Driver: string;
  Mountpoint: string;
  CreatedAt: string;
  Labels: Record<string, string>;
  Scope: string;
  Options: Record<string, string>;
  UsageData?: { Size: number; RefCount: number };
}

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes: Record<string, string> };
  time: number;
  timeNano: number;
}

export interface AppEvent {
  id: number;
  created_at: string;
  kind: string;
  actor: string;
  object_type: string;
  object_name: string;
  container_id: string;
  image: string;
  message: string;
}

export interface WatchedImage {
  id?: number;
  container_id: string;
  container_name: string;
  image: string;
  current_digest: string;
  check_interval: number;
  auto_update: boolean;
  enabled: boolean;
  update_available?: boolean;
  last_checked_at?: string;
  created_at?: string;
}

export interface SystemInfo {
  ID: string;
  Containers: number;
  ContainersRunning: number;
  ContainersPaused: number;
  ContainersStopped: number;
  Images: number;
  ServerVersion: string;
  OperatingSystem: string;
  OSType: string;
  Architecture: string;
  NCPU: number;
  MemTotal: number;
  DockerRootDir: string;
  Name: string;
}

export interface DiskUsage {
  LayersSize: number;
  Containers: ContainerSummary[];
  Volumes: VolumeSummary[];
  Images: ImageSummary[];
  BuildCache: any[];
}

export interface HostStats {
  cpu_cores: number;
  cpu_pct: number;
  mem_total: number;
  mem_used: number;
  disk_total: number;
  disk_used: number;
}

export interface StackSummary {
  name: string;
  status: 'running' | 'partial' | 'stopped';
  services: number;
  running: number;
  has_file: boolean;
  config_files?: string;
  work_dir?: string;
}

export interface StackContainer {
  id: string;
  name: string;
  service: string;
  status: string;
  image: string;
}

export interface StackDetail extends StackSummary {
  containers: StackContainer[];
  compose_content?: string;
}

export interface Build {
  id: string;
  name: string;
  tag: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  step: string;
  total_steps: number;
  current_step: number;
  duration_ms: number;
  cache_pct: number;
  initiated_by: string;
  definition_id?: string;
  logs?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
}

export interface BuildDefinition {
  id: string;
  name: string;
  tag: string;
  source_type: 'inline' | 'git';
  git_url: string;
  git_branch: string;
  dockerfile_path: string;
  dockerfile: string;
  push_to_registry: boolean;
  registry_url: string;
  created_at: string;
  run_count: number;
  last_build_status?: string;
  last_built_at?: string;
}

export interface RegistryItem {
  id: number;
  name: string;
  url: string;
  type: string;
  username: string;
  images_count: number;
  status: 'connected' | 'unreachable' | 'unknown';
  created_at: string;
}

export interface RegistryImage {
  name: string;
  tags: string[];
}

// ── Git source control models ─────────────────────────────────────────────────

export interface GitRepo {
  id: number;
  name: string;
  path: string;
  remote_url: string;
  author_name: string;
  author_email: string;
  description: string;
  branch: string;
  ahead_by: number;
  behind_by: number;
  changed_count: number;
  last_commit?: GitCommit;
  created_at: string;
}

export interface GitFileStatus {
  path: string;
  old_path?: string;
  staged: string;   // M A D R C U ? (space = clean)
  unstaged: string; // M D U ? (space = clean)
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  tracking?: string;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export type ProjectType = 'compose' | 'dockerfile' | 'unknown';
export type ProjectStatus = 'idle' | 'building' | 'running' | 'stopped' | 'failed';

export interface Project {
  id: number;
  created_at: string;
  updated_at: string;
  name: string;
  description: string;
  path: string;
  type: ProjectType;
  status: ProjectStatus;
  image_tag: string;
  ports: string;
  container_id: string;
  branch: string;
  build_log?: string;
  run_log?: string;
  repo_id?: number;
}

export interface ProjectLogs {
  status: ProjectStatus;
  build_log: string;
  run_log: string;
}

export interface ProjectFileNode {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  lines?: number;
  children?: ProjectFileNode[];
}
