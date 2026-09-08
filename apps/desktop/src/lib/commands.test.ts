import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from './commands.ts';

function event(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

function registry(mac = true) {
  const r = new CommandRegistry(mac);
  const run = vi.fn();
  r.register(
    { id: 'file.open', title: 'Open File…', group: 'File', key: 'Mod+O', run },
    { id: 'file.save', title: 'Save', group: 'File', key: 'Mod+S', enabled: () => false, run },
    { id: 'view.source', title: 'Source Mode', group: 'View', run },
  );
  return { r, run };
}

describe('CommandRegistry', () => {
  it('rejects a duplicate id', () => {
    const { r, run } = registry();
    expect(() => r.register({ id: 'file.open', title: 'Again', group: 'File', run })).toThrow(
      /already registered/,
    );
  });

  it('formats each shortcut for the platform', () => {
    expect(registry(true).r.get('file.open').shortcut).toBe('⌘O');
    expect(registry(false).r.get('file.open').shortcut).toBe('Ctrl+O');
    expect(registry(true).r.get('view.source').shortcut).toBe('');
  });

  it('prefers a macOS-specific binding on macOS only', () => {
    const specs = {
      id: 'x',
      title: 'X',
      group: 'Edit',
      key: 'Mod+K',
      macKey: 'Mod+Alt+K',
      run: () => {},
    } as const;
    const mac = new CommandRegistry(true);
    mac.register(specs);
    const win = new CommandRegistry(false);
    win.register(specs);
    expect(mac.get('x').shortcut).toBe('⌥⌘K');
    expect(win.get('x').shortcut).toBe('Ctrl+K');
  });

  it('finds the command for a key event, disabled ones included', () => {
    const { r } = registry();
    expect(r.forEvent(event({ code: 'KeyO', metaKey: true }))?.id).toBe('file.open');
    expect(r.forEvent(event({ code: 'KeyS', metaKey: true }))?.id).toBe('file.save');
    expect(r.forEvent(event({ code: 'KeyQ', metaKey: true }))).toBeNull();
  });

  it('does not run a disabled command', () => {
    const { r, run } = registry();
    expect(r.run('file.save')).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(r.run('file.open')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('leaves hidden commands out of the menus but keeps their key', () => {
    const r = new CommandRegistry(true);
    const run = vi.fn();
    r.register({ id: 'go.tab1', title: 'Tab 1', group: 'Go', key: 'Mod+1', hidden: true, run });
    expect(r.menus()).toEqual([]);
    expect(r.forEvent(event({ code: 'Digit1', metaKey: true }))?.id).toBe('go.tab1');
  });

  it('groups commands into menus in a fixed order', () => {
    expect(registry().r.menus()).toEqual([
      { group: 'File', items: [expect.objectContaining({ id: 'file.open' }), expect.anything()] },
      { group: 'View', items: [expect.objectContaining({ id: 'view.source' })] },
    ]);
  });
});
