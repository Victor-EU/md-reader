import { element, type RenderNode, text } from './nodes.ts';

/**
 * The inline HTML whitelist of design 5.3, enforced at render time.
 *
 * Allowed: `span` with a `style` that sets only a colour, `mark`, `sub`,
 * `sup`, `u`, `s`, `br`, `kbd`, `details`, `summary`, and `img` with a
 * local source. Everything else — `script`, `iframe`, `style`, event
 * handlers, an unexpected attribute on an allowed tag — renders as the
 * literal text it is. Nothing is removed from the file; this is a
 * rendering decision, not a sanitizer.
 *
 * The rule that an unexpected attribute makes the whole tag literal is
 * deliberate. Dropping it silently would show the reader an element the
 * file does not describe; showing the tag as text shows exactly what is
 * written, which is the honest failure.
 */

export interface HtmlTag {
  kind: 'open' | 'close' | 'void';
  /** Lower-cased element name. */
  name: string;
  attrs: Record<string, string>;
}

/** Allowed elements, each with the attributes it may carry. */
const ALLOWED: Record<string, readonly string[]> = {
  span: ['style'],
  mark: [],
  sub: [],
  sup: [],
  u: [],
  s: [],
  br: [],
  kbd: [],
  details: ['open'],
  summary: [],
  img: ['src', 'alt', 'title', 'width', 'height'],
};

/** Allowed elements that never hold content, so they never open a frame. */
const VOID: ReadonlySet<string> = new Set(['br', 'img']);

/** Elements that only mean anything inside another one. */
const REQUIRES: Record<string, string> = { summary: 'details' };

const TAG =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>$/;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Only a colour, and only a colour a stylesheet would recognise. */
const COLOR = /^\s*color\s*:\s*([^;]+?)\s*;?\s*$/i;
const COLOR_VALUE = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\(\s*[\d\s.,%/-]+\))$/i;

/** A source may only point inside the document's own folder. */
const REMOTE = /^[a-z][a-z\d+\-.]*:/i;

export interface HtmlToken {
  /** True when the source is a tag; false for the text between tags. */
  tag: boolean;
  source: string;
  from: number;
  to: number;
}

/** The end of the tag starting at `at`, or -1 when it never closes. */
function tagEnd(source: string, at: number): number {
  let quote = '';
  for (let i = at + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch as string;
    else if (ch === '<') return -1;
    else if (ch === '>') return i + 1;
  }
  return -1;
}

/** Split raw HTML into its tags and the text between them. */
export function tokenizeHtml(source: string, offset = 0): HtmlToken[] {
  const out: HtmlToken[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '<') continue;
    const end = tagEnd(source, i);
    if (end < 0) continue;
    if (i > start) {
      out.push({
        tag: false,
        source: source.slice(start, i),
        from: offset + start,
        to: offset + i,
      });
    }
    out.push({ tag: true, source: source.slice(i, end), from: offset + i, to: offset + end });
    start = end;
    i = end - 1;
  }
  if (start < source.length) {
    out.push({
      tag: false,
      source: source.slice(start),
      from: offset + start,
      to: offset + source.length,
    });
  }
  return out;
}

/** Read one tag's source. Null when it is not a tag at all. */
export function parseTag(source: string): HtmlTag | null {
  const m = TAG.exec(source);
  if (!m) return null;
  const closing = m[1] === '/';
  const name = (m[2] ?? '').toLowerCase();
  const rest = m[3] ?? '';
  if (closing && rest.trim() !== '') return null;
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  for (let a = ATTRIBUTE.exec(rest); a; a = ATTRIBUTE.exec(rest)) {
    attrs[(a[1] ?? '').toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
  }
  const selfClosing = m[4] === '/';
  const kind = closing ? 'close' : selfClosing || VOID.has(name) ? 'void' : 'open';
  return { kind, name, attrs };
}

/**
 * Pair opening tags with their closing tags among a run of tags in one
 * container, by the rule `HtmlStack` applies: a close tag ends the
 * innermost open element of that name and abandons everything opened
 * inside it, and a close tag for nothing that is open is dropped.
 *
 * Returns, for each tag, the index of the tag that closes it, or null.
 * Entries that are not tags at all are passed as null and paired with
 * nothing, so a caller can hand in a whole token run unfiltered.
 */
export function pairTags(tags: readonly (HtmlTag | null)[]): (number | null)[] {
  const closer: (number | null)[] = tags.map(() => null);
  const open: number[] = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (!tag || tag.kind === 'void') continue;
    if (tag.kind === 'open') {
      open.push(i);
      continue;
    }
    let at = -1;
    for (let k = open.length - 1; k >= 0; k--) {
      if ((tags[open[k] as number] as HtmlTag).name === tag.name) {
        at = k;
        break;
      }
    }
    if (at === -1) continue;
    closer[open[at] as number] = i;
    open.length = at;
  }
  return closer;
}

/**
 * The attributes an allowed tag renders with, or null when the tag is not
 * allowed to render at all.
 */
export function allowedAttrs(tag: HtmlTag): Record<string, string> | null {
  const permitted = ALLOWED[tag.name];
  if (!permitted) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(tag.attrs)) {
    if (!permitted.includes(name)) return null;
    if (name === 'style') {
      const declaration = COLOR.exec(value);
      const color = declaration?.[1];
      if (color === undefined || !COLOR_VALUE.test(color)) return null;
      out.style = `color:${color}`;
      continue;
    }
    if (name === 'width' || name === 'height') {
      if (!/^\d+$/.test(value)) return null;
      out[name] = value;
      continue;
    }
    out[name] = value;
  }
  if (tag.name === 'img') {
    const src = out.src;
    // A remote image is a request to a third party; design 8 blocks it
    // unless the reader turns it on, and the markdown syntax is the path
    // through which that choice is made.
    if (src === undefined || src === '' || REMOTE.test(src) || src.startsWith('//')) return null;
    if (out.alt === undefined) out.alt = '';
  }
  return out;
}

/** Whether a tag renders at all, closing tags included. */
export function tagRenders(source: string): boolean {
  const tag = parseTag(source);
  if (!tag) return false;
  if (tag.kind === 'close') return tag.name in ALLOWED;
  return allowedAttrs(tag) !== null;
}

export interface HtmlStackOptions {
  /**
   * How an `<img>` becomes a node. The whitelist decides that the tag may
   * render; whether the file it points at may be loaded is design 8's
   * question, which only the renderer can answer.
   */
  image?: (attrs: Record<string, string>, from: number, to: number) => RenderNode;
}

interface Frame {
  name: string;
  attrs: Record<string, string>;
  from: number;
  /** The opening tag's own source, shown as text when nothing closes it. */
  source: string;
  sourceTo: number;
  children: RenderNode[];
}

/**
 * Builds a node list in which whitelisted HTML tags nest, pairing an
 * opening tag with its closing one.
 *
 * Lezer emits one node per tag rather than a matched pair, and a block
 * level `<details>` is a separate block from the `</details>` five
 * paragraphs below it. Both cases are the same problem, so both use this:
 * content accumulates into the innermost open frame, and a frame nothing
 * closes gives its opening tag back as text.
 */
export class HtmlStack {
  private readonly root: RenderNode[] = [];
  private readonly frames: Frame[] = [];

  constructor(private readonly options: HtmlStackOptions = {}) {}

  /** True while a tag is open, so loose text belongs to an element. */
  get inElement(): boolean {
    return this.frames.length > 0;
  }

  /** Where content is going right now. */
  private get target(): RenderNode[] {
    return this.frames[this.frames.length - 1]?.children ?? this.root;
  }

  push(node: RenderNode): void {
    this.target.push(node);
  }

  pushAll(nodes: readonly RenderNode[]): void {
    for (const node of nodes) this.target.push(node);
  }

  /**
   * Take one HTML tag. Returns false when the tag renders as literal
   * text, which is the caller's cue to push its source.
   */
  tag(source: string, from: number, to: number): boolean {
    const tag = parseTag(source);
    if (!tag) return false;
    if (tag.kind === 'close') return this.close(tag.name, to);
    const attrs = allowedAttrs(tag);
    if (!attrs) return false;
    const needs = REQUIRES[tag.name];
    if (needs !== undefined && !this.frames.some((frame) => frame.name === needs)) return false;
    if (tag.kind === 'void') {
      const image = tag.name === 'img' ? this.options.image : undefined;
      this.push(image ? image(attrs, from, to) : element(tag.name, attrs, from, to));
      return true;
    }
    this.frames.push({ name: tag.name, attrs, from, source, sourceTo: to, children: [] });
    return true;
  }

  /** Everything collected, with any frame nothing closed given back as text. */
  finish(): RenderNode[] {
    while (this.frames.length > 0) this.abandon();
    return this.root;
  }

  private close(name: string, to: number): boolean {
    let index = this.frames.length - 1;
    while (index >= 0 && this.frames[index]?.name !== name) index -= 1;
    if (index < 0) return false;
    // Tags that opened inside it and never closed are text, so the
    // content between them survives where the writer put it.
    while (this.frames.length - 1 > index) this.abandon();
    const frame = this.frames.pop();
    if (!frame) return false;
    this.target.push(element(frame.name, frame.attrs, frame.from, to, frame.children));
    return true;
  }

  /** Undo the innermost frame: its opening tag becomes text again. */
  private abandon(): void {
    const frame = this.frames.pop();
    if (!frame) return;
    const out = this.target;
    out.push(text(frame.source, frame.from, frame.sourceTo));
    for (const child of frame.children) out.push(child);
  }
}
