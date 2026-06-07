import { ConfirmDialogService } from './confirm-dialog.service';

describe('ConfirmDialogService', () => {
  it('emits a request and resolves to the chosen value', async () => {
    const svc = new ConfirmDialogService();
    const sub = svc.request$.subscribe(({ config, resolve }) => {
      expect(config.title).toBe('Delete?');
      resolve(true);
    });
    await expectAsync(svc.confirm({ title: 'Delete?' })).toBeResolvedTo(true);
    sub.unsubscribe();
  });

  it('resolves to false on cancel', async () => {
    const svc = new ConfirmDialogService();
    const sub = svc.request$.subscribe(({ resolve }) => resolve(false));
    await expectAsync(svc.confirm({ title: 'x' })).toBeResolvedTo(false);
    sub.unsubscribe();
  });

  it('confirmWithCheckbox returns both confirmed and checked', async () => {
    const svc = new ConfirmDialogService();
    const sub = svc.checkboxRequest$.subscribe(({ config, resolve }) => {
      expect(config.checkboxLabel).toBe('Also remove image');
      resolve({ confirmed: true, checked: false });
    });
    const result = await svc.confirmWithCheckbox({ title: 'x', checkboxLabel: 'Also remove image' });
    expect(result).toEqual({ confirmed: true, checked: false });
    sub.unsubscribe();
  });
});
