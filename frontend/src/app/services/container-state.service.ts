import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ContainerSummary, ContainerInspect } from '../models/docker.models';

export interface ContainerPageState {
  containers: ContainerSummary[];
  containerFilter: 'all' | 'running' | 'stopped';
  searchQuery: string;
  selectedId: string | null;
  detailTab: string;
  inspect: ContainerInspect | null;
}

const INITIAL: ContainerPageState = {
  containers: [],
  containerFilter: 'all',
  searchQuery: '',
  selectedId: null,
  detailTab: 'overview',
  inspect: null,
};

@Injectable({ providedIn: 'root' })
export class ContainerStateService {
  private _state = new BehaviorSubject<ContainerPageState>({ ...INITIAL });
  readonly state$: Observable<ContainerPageState> = this._state.asObservable();

  get snapshot(): ContainerPageState { return this._state.value; }

  patch(partial: Partial<ContainerPageState>): void {
    this._state.next({ ...this._state.value, ...partial });
  }

  get hasCache(): boolean { return this._state.value.containers.length > 0; }
}
