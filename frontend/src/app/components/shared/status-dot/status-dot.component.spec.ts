import { StatusDotComponent, statusTone } from './status-dot.component';

describe('statusTone', () => {
  it('maps running to the running tone', () => {
    expect(statusTone('running')).toBe('running');
    expect(statusTone('RUNNING')).toBe('running');
  });

  it('maps paused/restarting to warn', () => {
    expect(statusTone('paused')).toBe('warn');
    expect(statusTone('restarting')).toBe('warn');
  });

  it('maps exited/dead/removing to danger', () => {
    expect(statusTone('exited')).toBe('danger');
    expect(statusTone('dead')).toBe('danger');
    expect(statusTone('removing')).toBe('danger');
  });

  it('maps created to info', () => {
    expect(statusTone('created')).toBe('info');
  });

  it('falls back to idle for unknown/empty', () => {
    expect(statusTone('something-else')).toBe('idle');
    expect(statusTone('')).toBe('idle');
  });
});

describe('StatusDotComponent', () => {
  it('resolves a CSS variable colour from the tone', () => {
    const c = new StatusDotComponent();
    c.tone = 'running';
    expect(c.color).toContain('--running-400');
    c.tone = 'danger';
    expect(c.color).toContain('--danger-400');
  });

  it('defaults to the idle colour for an unset tone', () => {
    const c = new StatusDotComponent();
    expect(c.color).toContain('--idle-400');
  });
});
