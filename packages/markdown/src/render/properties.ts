/**
 * The frontmatter properties panel of design 5.1, read straight off the
 * lines of the block.
 *
 * The YAML is never parsed into a document model and never re-emitted:
 * every property carries the exact source range of its own line, so
 * editing one property replaces that line and nothing else, and the file
 * keeps its quoting, its spacing, and its key order (principle 1).
 *
 * Only the shapes a frontmatter block actually uses are modelled — a
 * scalar per line, and a block sequence under a key. Anything else, a
 * nested map or a folded scalar, means the panel cannot claim to
 * represent the block, so `properties` returns null and the caller shows
 * the YAML as it stands.
 */

export interface Property {
  key: string;
  /** The scalar after the colon, trimmed. Empty for a list. */
  value: string;
  /** The items of a block sequence, or null when the property is a scalar. */
  items: string[] | null;
  /** The start of the property's first line, and the end of its last. */
  from: number;
  to: number;
  /** Where the scalar sits, for an edit that replaces only the value. */
  valueFrom: number;
  valueTo: number;
}

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*):(?:[ \t]+(.*))?$/;
const ITEM = /^[ \t]+-[ \t]+(.+?)[ \t]*$/;
const COMMENT = /^[ \t]*#/;

/**
 * The properties of a frontmatter block, or null when the block holds
 * something this panel would misrepresent.
 *
 * `from` is the source offset of the first character of `content`.
 */
export function properties(content: string, from: number): Property[] | null {
  const out: Property[] = [];
  let pos = from;
  for (const line of content.split('\n')) {
    const lineFrom = pos;
    pos += line.length + 1;
    const lineTo = lineFrom + line.length;
    if (line.trim() === '' || COMMENT.test(line)) continue;

    const item = ITEM.exec(line);
    if (item?.[1] !== undefined) {
      const last = out.at(-1);
      // A sequence item only makes sense under a key with no scalar.
      if (last?.value !== '') return null;
      last.items = [...(last.items ?? []), item[1]];
      last.to = lineTo;
      continue;
    }

    const m = KEY.exec(line);
    if (!m?.[1]) return null;
    const key = m[1];
    const value = m[2] ?? '';
    const valueFrom = lineTo - value.length;
    out.push({
      key,
      value: value.trimEnd(),
      items: null,
      from: lineFrom,
      to: lineTo,
      valueFrom,
      valueTo: lineTo,
    });
  }
  return out;
}

/**
 * The text of a line that sets `key` to `value`, in the style the block
 * already uses. Callers replace exactly one line with it.
 */
export function propertyLine(key: string, value: string): string {
  return value === '' ? `${key}:` : `${key}: ${value}`;
}
