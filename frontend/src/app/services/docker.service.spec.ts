import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DockerService } from './docker.service';

describe('DockerService', () => {
  let svc: DockerService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [DockerService, provideHttpClient(), provideHttpClientTesting()],
    });
    svc = TestBed.inject(DockerService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getProject requests the project by id', () => {
    svc.getProject(7).subscribe();
    const req = http.expectOne('/api/v1/projects/7');
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('deleteProject without purge omits the query string', () => {
    svc.deleteProject(3).subscribe();
    const req = http.expectOne('/api/v1/projects/3');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('deleteProject with purge sets purge=true', () => {
    svc.deleteProject(3, true).subscribe();
    const req = http.expectOne('/api/v1/projects/3?purge=true');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('checkWatchedImage posts to /watcher/check with the container_id param', () => {
    svc.checkWatchedImage('abc123').subscribe();
    const req = http.expectOne(
      r => r.url === '/api/v1/watcher/check' && r.params.get('container_id') === 'abc123',
    );
    expect(req.request.method).toBe('POST');
    req.flush({});
  });

  it('updateWatchedImage posts to /watcher/update with the container_id param', () => {
    svc.updateWatchedImage('abc123').subscribe();
    const req = http.expectOne(
      r => r.url === '/api/v1/watcher/update' && r.params.get('container_id') === 'abc123',
    );
    expect(req.request.method).toBe('POST');
    req.flush({});
  });

  it('createAlert posts to /alerts', () => {
    svc.createAlert({ name: 'High CPU', type: 'host_cpu', threshold: 80 }).subscribe();
    const req = http.expectOne('/api/v1/alerts');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.name).toBe('High CPU');
    req.flush({});
  });
});
