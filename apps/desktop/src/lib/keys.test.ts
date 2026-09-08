import { describe, expect, it } from 'vitest';
import { bindingMatches, formatBinding, parseBinding } from './keys.ts';

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

describe('parseBinding', () => {
  it('reads modifiers and maps the key to a physical code', () => {
    expect(parseBinding('Mod+Shift+P')).toEqual({
      code: 'KeyP',
      key: 'P',
      mod: true,
      shift: true,
      alt: false,
      ctrl: false,
    });
    expect(parseBinding('Mod+1').code).toBe('Digit1');
    expect(parseBinding('Mod+Shift+[').code).toBe('BracketLeft');
    expect(parseBinding('Escape').code).toBeNull();
  });

  it('rejects an unknown modifier', () => {
    expect(() => parseBinding('Hyper+P')).toThrow(/unknown modifier/);
  });
});

describe('bindingMatches', () => {
  const modP = parseBinding('Mod+P');

  it('takes Cmd on macOS and Ctrl elsewhere', () => {
    expect(bindingMatches(modP, event({ code: 'KeyP', metaKey: true }), true)).toBe(true);
    expect(bindingMatches(modP, event({ code: 'KeyP', ctrlKey: true }), true)).toBe(false);
    expect(bindingMatches(modP, event({ code: 'KeyP', ctrlKey: true }), false)).toBe(true);
    expect(bindingMatches(modP, event({ code: 'KeyP', metaKey: true }), false)).toBe(false);
  });

  it('requires the modifier set to match exactly', () => {
    const e = event({ code: 'KeyP', metaKey: true, shiftKey: true });
    expect(bindingMatches(modP, e, true)).toBe(false);
    expect(bindingMatches(parseBinding('Mod+Shift+P'), e, true)).toBe(true);
  });

  it('matches the bracket keys through the code, not the shifted character', () => {
    const e = event({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(bindingMatches(parseBinding('Mod+Shift+['), e, true)).toBe(true);
  });

  it('falls back to the key name when the event carries no code', () => {
    expect(bindingMatches(modP, event({ key: 'p', metaKey: true }), true)).toBe(true);
    expect(bindingMatches(parseBinding('Escape'), event({ key: 'Escape' }), true)).toBe(true);
  });
});

describe('formatBinding', () => {
  it('writes symbols on macOS and words elsewhere', () => {
    expect(formatBinding(parseBinding('Mod+Shift+P'), true)).toBe('⇧⌘P');
    expect(formatBinding(parseBinding('Mod+Shift+P'), false)).toBe('Ctrl+Shift+P');
    expect(formatBinding(parseBinding('Mod+Alt+ArrowLeft'), true)).toBe('⌥⌘←');
  });
});
