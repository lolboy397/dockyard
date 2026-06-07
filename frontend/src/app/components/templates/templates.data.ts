/** A configurable variable substituted into a template's compose YAML. */
export interface TemplateVar {
  key: string;                       // placeholder name, used as {{KEY}}
  label: string;
  value: string;                     // default / current value
  type?: 'text' | 'password' | 'number';
  hint?: string;
}

/** A curated one-click application template. */
export interface AppTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;                      // lucide icon name
  category: string;
  vars: TemplateVar[];
  compose: string;                   // compose YAML using {{KEY}} placeholders
}

/**
 * Curated app catalog. Selecting one pre-fills the stack-deploy flow: the chosen
 * variable values are substituted into the compose YAML and deployed via the
 * existing StackHandlers.Deploy endpoint.
 */
export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Reliable open-source relational database (postgres:16-alpine).',
    icon: 'database',
    category: 'Database',
    vars: [
      { key: 'POSTGRES_USER', label: 'Username', value: 'postgres' },
      { key: 'POSTGRES_PASSWORD', label: 'Password', value: 'change-me-please', type: 'password' },
      { key: 'POSTGRES_DB', label: 'Database name', value: 'app' },
      { key: 'PORT', label: 'Host port', value: '5432', type: 'number' },
    ],
    compose: `services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: "{{POSTGRES_USER}}"
      POSTGRES_PASSWORD: "{{POSTGRES_PASSWORD}}"
      POSTGRES_DB: "{{POSTGRES_DB}}"
    ports:
      - "{{PORT}}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`,
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'In-memory data store and cache (redis:7-alpine).',
    icon: 'layers',
    category: 'Database',
    vars: [
      { key: 'REDIS_PASSWORD', label: 'Password', value: 'change-me-please', type: 'password' },
      { key: 'PORT', label: 'Host port', value: '6379', type: 'number' },
    ],
    compose: `services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "{{REDIS_PASSWORD}}"]
    ports:
      - "{{PORT}}:6379"
    volumes:
      - redisdata:/data
volumes:
  redisdata:
`,
  },
  {
    id: 'n8n',
    name: 'n8n',
    description: 'Workflow automation with a fair-code license.',
    icon: 'workflow',
    category: 'Automation',
    vars: [
      { key: 'N8N_USER', label: 'Admin user', value: 'admin' },
      { key: 'N8N_PASSWORD', label: 'Admin password', value: 'change-me-please', type: 'password' },
      { key: 'PORT', label: 'Host port', value: '5678', type: 'number' },
    ],
    compose: `services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "{{PORT}}:5678"
    environment:
      N8N_BASIC_AUTH_ACTIVE: "true"
      N8N_BASIC_AUTH_USER: "{{N8N_USER}}"
      N8N_BASIC_AUTH_PASSWORD: "{{N8N_PASSWORD}}"
    volumes:
      - n8ndata:/home/node/.n8n
volumes:
  n8ndata:
`,
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    description: 'Self-hosted uptime monitoring with a clean dashboard.',
    icon: 'activity',
    category: 'Monitoring',
    vars: [
      { key: 'PORT', label: 'Host port', value: '3001', type: 'number' },
    ],
    compose: `services:
  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "{{PORT}}:3001"
    volumes:
      - kuma:/app/data
volumes:
  kuma:
`,
  },
  {
    id: 'gitea',
    name: 'Gitea',
    description: 'Lightweight self-hosted Git service.',
    icon: 'git-branch',
    category: 'Developer',
    vars: [
      { key: 'HTTP_PORT', label: 'HTTP port', value: '3000', type: 'number' },
      { key: 'SSH_PORT', label: 'SSH port', value: '2222', type: 'number' },
    ],
    compose: `services:
  gitea:
    image: gitea/gitea:1.22
    restart: unless-stopped
    environment:
      USER_UID: "1000"
      USER_GID: "1000"
    ports:
      - "{{HTTP_PORT}}:3000"
      - "{{SSH_PORT}}:22"
    volumes:
      - gitea:/data
volumes:
  gitea:
`,
  },
  {
    id: 'whoami',
    name: 'whoami',
    description: 'Tiny HTTP server echoing request info — handy for testing.',
    icon: 'globe',
    category: 'Utility',
    vars: [
      { key: 'PORT', label: 'Host port', value: '8088', type: 'number' },
    ],
    compose: `services:
  whoami:
    image: traefik/whoami:latest
    restart: unless-stopped
    ports:
      - "{{PORT}}:80"
`,
  },
];
