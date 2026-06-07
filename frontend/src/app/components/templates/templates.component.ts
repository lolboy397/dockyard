import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IconComponent } from '../shared/icon/icon.component';
import { ModalComponent } from '../shared/modal/modal.component';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { AuthService } from '../../auth/auth.service';
import { APP_TEMPLATES, AppTemplate, TemplateVar } from './templates.data';

/** One-click app catalog — pre-fills the stack-deploy flow from curated templates. */
@Component({
  selector: 'app-templates',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ModalComponent],
  styleUrls: ['./templates.component.scss'],
  templateUrl: './templates.component.html',
})
export class TemplatesComponent {
  templates = APP_TEMPLATES;

  active: AppTemplate | null = null;
  vars: TemplateVar[] = [];
  stackName = '';
  deploying = false;

  constructor(
    public auth: AuthService,
    private docker: DockerService,
    private notify: NotificationService,
    private router: Router,
  ) {}

  openDeploy(t: AppTemplate): void {
    this.active = t;
    this.stackName = t.id;
    // Clone the vars so edits don't mutate the shared catalog.
    this.vars = t.vars.map(v => ({ ...v }));
  }

  close(): void {
    this.active = null;
    this.vars = [];
    this.deploying = false;
  }

  private render(t: AppTemplate, vars: TemplateVar[]): string {
    let yaml = t.compose;
    for (const v of vars) {
      yaml = yaml.split('{{' + v.key + '}}').join(v.value);
    }
    return yaml;
  }

  deploy(): void {
    if (!this.active) return;
    const name = this.stackName.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    if (!name) {
      this.notify.error('Enter a stack name');
      return;
    }
    const t = this.active;
    const yaml = this.render(t, this.vars);
    this.deploying = true;
    this.docker.deployStack(name, yaml).subscribe({
      next: () => {
        this.notify.success(`Deploying ${t.name} as "${name}"`);
        this.close();
        this.router.navigate(['/stacks']);
      },
      error: e => {
        this.notify.error(e?.error?.error || 'Deploy failed');
        this.deploying = false;
      },
    });
  }
}
