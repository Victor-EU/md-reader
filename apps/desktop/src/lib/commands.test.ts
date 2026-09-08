import { editorKeys } from '@mdreader/editor-core';
import { describe, expect, it, vi } from 'vitest';
import { appCommands } from './app-commands.ts';
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

/**
 * The editor's keymap sits on the content element and the shell's sits on
 * the window, so a key the editor claims never reaches the shell: it
 * calls `preventDefault` and the window handler leaves it alone. A
 * collision is therefore silent, and this is what makes it loud.
 *
 * Cmd+I was one: `defaultKeymap` binds it to `selectParentSyntax`, so
 * italic did nothing until `state.ts` took the binding out.
 */
describe('the two keymaps', () => {
  /** A CodeMirror key string as a shell binding, on macOS. */
  function asBinding(spec: string) {
    const parts = spec.split('-');
    const key = parts.pop() ?? '';
    const has = (name: string) => parts.some((p) => p.toLowerCase() === name);
    return {
      key: key.toLowerCase(),
      meta: has('mod') || has('cmd') || has('meta'),
      ctrl: has('ctrl') || has('control'),
      shift: has('shift'),
      alt: has('alt') || has('option'),
    };
  }

  it('never claim the same shortcut', () => {
    const workspace = { activeTab: null, activeDoc: null, find: { query: '' } };
    const shell = new CommandRegistry(true);
    shell.register(...appCommands(workspace as never));
    const clashes: string[] = [];
    for (const binding of editorKeys()) {
      // `mac` overrides `key` on this platform, and a binding with
      // neither is a `any`-style handler with no shortcut at all.
      const spec = binding.mac ?? binding.key;
      if (spec === undefined) continue;
      const want = asBinding(spec);
      const command = shell.forEvent(
        event({
          key: want.key,
          code: /^[a-z]$/.test(want.key) ? `Key${want.key.toUpperCase()}` : '',
          metaKey: want.meta,
          ctrlKey: want.ctrl,
          shiftKey: want.shift,
          altKey: want.alt,
        }),
      );
      if (command) clashes.push(`${spec} is both the editor's and ${command.id}`);
    }
    expect(clashes).toEqual([]);
  });
});
