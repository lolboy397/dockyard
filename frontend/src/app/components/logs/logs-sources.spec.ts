import { planSourceReconcile, ReconcileSource } from './logs-sources';

const PALETTE = ['#a', '#b', '#c'];
const cont = (Id: string, name: string, State = 'running') => ({ Id, Names: ['/' + name], State });
const src = (id: string, name: string, on: boolean, color = '#x'): ReconcileSource => ({ id, name, color, on });

describe('planSourceReconcile', () => {
  it('keeps a stable list unchanged and subscribes nothing new', () => {
    const prev = [src('a', 'web', true), src('b', 'db', false)];
    const plan = planSourceReconcile(prev, [cont('a', 'web'), cont('b', 'db')], null, PALETTE);
    expect(plan.unsubscribe).toEqual([]);
    expect(plan.subscribe).toEqual([]);
    expect(plan.next.map(s => s.on)).toEqual([true, false]);
  });

  it('adds a new running container as an active, subscribed source', () => {
    const plan = planSourceReconcile([src('a', 'web', true)], [cont('a', 'web'), cont('b', 'db')], null, PALETTE);
    expect(plan.subscribe).toEqual(['b']);
    expect(plan.next.find(s => s.id === 'b')?.on).toBe(true);
  });

  it('does not subscribe a new container that is not running', () => {
    const plan = planSourceReconcile([], [cont('b', 'db', 'exited')], null, PALETTE);
    expect(plan.subscribe).toEqual([]);
    expect(plan.next[0].on).toBe(false);
  });

  it('drops and unsubscribes a vanished container', () => {
    const prev = [src('a', 'web', true), src('b', 'db', true)];
    const plan = planSourceReconcile(prev, [cont('a', 'web')], null, PALETTE);
    expect(plan.unsubscribe).toEqual(['b']);
    expect(plan.next.map(s => s.id)).toEqual(['a']);
  });

  it('carries selection across a recreate (new id, same name) and subscribes the new id', () => {
    const prev = [src('old', 'web', true)];
    const plan = planSourceReconcile(prev, [cont('new', 'web')], null, PALETTE);
    expect(plan.unsubscribe).toEqual(['old']);
    expect(plan.subscribe).toEqual(['new']);
    expect(plan.next[0]).toEqual(jasmine.objectContaining({ id: 'new', name: 'web', on: true }));
  });

  it('does not re-subscribe a recreated container that was toggled off', () => {
    const prev = [src('old', 'web', false)];
    const plan = planSourceReconcile(prev, [cont('new', 'web')], null, PALETTE);
    expect(plan.subscribe).toEqual([]);
    expect(plan.next[0].on).toBe(false);
  });

  it('honours savedOnIds for a brand-new container with no prior same-named source', () => {
    const on = planSourceReconcile([], [cont('z', 'cache')], new Set(['z']), PALETTE);
    expect(on.subscribe).toEqual(['z']);
    const off = planSourceReconcile([], [cont('z', 'cache')], new Set(['other']), PALETTE);
    expect(off.subscribe).toEqual([]);
    expect(off.next[0].on).toBe(false);
  });

  it('preserves an existing source colour so churn does not reshuffle the palette', () => {
    const prev = [src('a', 'web', true, '#keep')];
    const plan = planSourceReconcile(prev, [cont('a', 'web'), cont('b', 'db')], null, PALETTE);
    expect(plan.next.find(s => s.id === 'a')?.color).toBe('#keep');
  });
});
