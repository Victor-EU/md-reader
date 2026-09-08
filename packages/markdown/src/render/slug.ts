/**
 * GitHub-style heading anchors, so `[Section](#section)` in a document
 * written for GitHub resolves here too.
 *
 * The rule GitHub applies: fold case, drop everything that is not a letter,
 * a number, a space, a hyphen, or an underscore, then turn runs of spaces
 * into single hyphens. A repeated heading gets `-1`, `-2`, and so on, in
 * document order, which is why this is a class and not a function.
 */
export class Slugger {
  private readonly seen = new Map<string, number>();

  /** The id for one heading, unique among the ones already assigned. */
  slug(headingText: string): string {
    const base = Slugger.base(headingText);
    const count = this.seen.get(base);
    if (count === undefined) {
      this.seen.set(base, 0);
      return base;
    }
    // Keep counting until the suffixed form is free too: a document with
    // "Notes", "Notes", and a literal "Notes 1" must still give three ids.
    let next = count + 1;
    while (this.seen.has(`${base}-${next}`)) next += 1;
    this.seen.set(base, next);
    const id = `${base}-${next}`;
    this.seen.set(id, 0);
    return id;
  }

  reset(): void {
    this.seen.clear();
  }

  static base(headingText: string): string {
    const slug = headingText
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N} \-_]/gu, '')
      .replace(/ +/g, '-');
    return slug === '' ? 'section' : slug;
  }
}
