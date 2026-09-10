import type { ImageResolver, ImageTarget } from '@markdown/markdown';
import { dirname, resolvePath } from './paths.ts';

/**
 * Design 8's image rules, as the one function both views resolve through.
 *
 * A relative path is resolved against the document's own folder and
 * loaded over the asset protocol, whose scope Rust has already been asked
 * to widen to that folder. A remote source is not loaded at all until the
 * reader turns it on for this document: fetching it would tell a third
 * party that this person opened this file, which is not a thing to do on
 * a document's say-so.
 */
export interface ImageRules {
  /** The document's path, or null while it is untitled. */
  path: string | null;
  /** Whether the reader has allowed remote images for this document. */
  remote: boolean;
  /** Turns a local path into a URL the webview may load. */
  assetUrl?: ((path: string) => string) | undefined;
}

/**
 * A source that names a host rather than a path in the document's own
 * folder, and so is somebody else's to serve.
 *
 * `\\host\share.png` belongs here with `//host/x`: a UNC path is a
 * Windows file share, and resolving one against the document's folder is
 * this machine reaching out to a stranger's server -- and, on Windows,
 * offering it a login on the way. It is the same reading the renderer's
 * own link check gives the same two spellings.
 */
const REMOTE = /^(?:https?:|\/\/|\\\\)/i;
const DATA = /^data:image\//i;

/** Strip a query or fragment, and undo the percent encoding a path may carry. */
function filePath(src: string): string {
  const clean = src.replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

export function resolveImage(src: string, rules: ImageRules): ImageTarget {
  const trimmed = src.trim();
  if (trimmed === '') return { url: null };
  if (DATA.test(trimmed)) return { url: trimmed };
  if (REMOTE.test(trimmed)) {
    return rules.remote ? { url: trimmed } : { url: null, blocked: 'remote' };
  }
  const dir = rules.path === null ? '' : dirname(rules.path);
  if (dir === '' || !rules.assetUrl) return { url: null, blocked: 'unavailable' };
  return { url: rules.assetUrl(resolvePath(dir, filePath(trimmed))) };
}

/** The resolver for one document, reading its rules afresh on every image. */
export function imageResolver(rules: () => ImageRules): ImageResolver {
  return (src) => resolveImage(src, rules());
}
