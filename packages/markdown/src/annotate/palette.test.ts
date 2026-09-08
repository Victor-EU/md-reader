import { describe, expect, it } from 'vitest';
import { allowedAttrs, parseTag } from '../render/whitelist.ts';
import { colorStyle, meaningOfColor, palette, paletteMeanings } from './palette.ts';

describe('the palette', () => {
  it('has one entry per meaning, each with its own colour', () => {
    expect(palette.map((entry) => entry.meaning)).toEqual([...paletteMeanings]);
    expect(new Set(palette.map((entry) => entry.color)).size).toBe(palette.length);
  });

  it('writes a span the whitelist renders', () => {
    for (const entry of palette) {
      const tag = parseTag(`<span style="${colorStyle(entry.color)}">`);
      expect(allowedAttrs(tag as NonNullable<typeof tag>)).toEqual({
        style: `color:${entry.color}`,
      });
    }
  });

  it('reads its own colours back, in either hex form', () => {
    for (const entry of palette) {
      expect(meaningOfColor(entry.color)).toBe(entry.meaning);
      expect(meaningOfColor(entry.color.toUpperCase())).toBe(entry.meaning);
    }
    expect(meaningOfColor('#f00')).toBeNull();
    expect(meaningOfColor('rebeccapurple')).toBeNull();
  });
});
