import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IconComponent } from '../shared/icon/icon.component';
import { ModalComponent } from '../shared/modal/modal.component';
import { DockerService } from '../../services/docker.service';
import { NotificationService } from '../../services/notification.service';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { AuthService } from '../../auth/auth.service';
import { RegistryItem, RegistryImage } from '../../models/docker.models';

@Component({
  selector: 'app-registry',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, ModalComponent],
  templateUrl: './registry.component.html',
})
export class RegistryComponent implements OnInit {
  registries: RegistryItem[] = [];
  internalImages: RegistryImage[] = [];
  loading = false;
  loadingImages = false;
  showAdd = false;
  showImages = false;

  newReg = { url: '', name: '', username: '', password: '' };

  constructor(private docker: DockerService, private notify: NotificationService, private confirm: ConfirmDialogService, public auth: AuthService) {}

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.docker.listRegistries().subscribe({
      next: regs => {
        this.registries = regs;
        this.loading = false;
      },
      error: () => { this.loading = false; },
    });
  }

  addRegistry(): void {
    if (!this.newReg.url) return;
    this.docker.addRegistry({
      url: this.newReg.url,
      name: this.newReg.name || this.newReg.url,
      username: this.newReg.username || undefined,
      password: this.newReg.password || undefined,
    }).subscribe({
      next: () => {
        this.notify.success(`Registry ${this.newReg.url} added`);
        this.showAdd = false;
        this.newReg = { url: '', name: '', username: '', password: '' };
        this.load();
      },
      error: (err) => this.notify.error(err?.error?.error || 'Failed to add registry'),
    });
  }

  async removeRegistry(r: RegistryItem): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove "${r.name}"?`,
      message: `${r.url} will be removed and you will be logged out.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    this.docker.removeRegistry(r.id).subscribe({
      next: () => { this.notify.success(`Removed ${r.name}`); this.load(); },
      error: () => this.notify.error('Remove failed'),
    });
  }

  loadInternalImages(): void {
    this.loadingImages = true;
    this.docker.listInternalImages().subscribe({
      next: imgs => { this.internalImages = imgs; this.loadingImages = false; },
      error: () => { this.loadingImages = false; },
    });
  }

  toggleImages(): void {
    this.showImages = !this.showImages;
    if (this.showImages) this.loadInternalImages();
  }

  // Toggle images section and load if opening
  get showImagesState(): boolean { return this.showImages; }
  set showImagesState(val: boolean) {
    this.showImages = val;
    if (val) this.loadInternalImages();
  }
}
