/**
 * Putting things on the clipboard (design 9.1). Three flavours reach it:
 * the exact markdown source, rich text for a document or an email, and
 * the source plus the generated annotations section for a model.
 *
 * Rich text is written as `text/html` with the plain text beside it, so a
 * target that wants one gets it and a target that wants the other gets
 * markdown rather than a flattened rendering.
 */

export interface ClipboardWriter {
  write?(items: ClipboardItem[]): Promise<void>;
  writeText?(text: string): Promise<void>;
}

function itemFor(html: string, text: string): ClipboardItem {
  return new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([text], { type: 'text/plain' }),
  });
}

/**
 * The old path, for an engine that will not give us the asynchronous one.
 * `execCommand` copies whatever is selected, so a hidden textarea holds
 * the plain text and a one-shot `copy` handler replaces both flavours
 * with what we actually mean to write.
 */
function legacyCopy(html: string | null, text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(area);
  const active = document.activeElement as HTMLElement | null;
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
    if (html !== null) event.clipboardData?.setData('text/html', html);
  };
  document.addEventListener('copy', onCopy, { once: true });
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy);
    area.remove();
    active?.focus();
  }
}

/** Write plain text, through whichever path the engine offers. */
export async function copyText(
  text: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
): Promise<boolean> {
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through: a rejected write is a reason to try the old path.
  }
  return legacyCopy(null, text);
}

/** Write rich text with the source beside it, so both kinds of target are served. */
export async function copyRich(
  html: string,
  text: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
): Promise<boolean> {
  try {
    if (clipboard?.write && typeof ClipboardItem === 'function') {
      await clipboard.write([itemFor(html, text)]);
      return true;
    }
  } catch {
    // Fall through, as above.
  }
  return legacyCopy(html, text);
}
