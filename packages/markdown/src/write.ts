/**
 * The small decisions that come up whenever the app writes markdown
 * rather than reads it. Shared, because getting one of them wrong in one
 * place and right in another is how a file ends up saying two things.
 */

/**
 * A destination as it goes between the parentheses of a link.
 *
 * A space or a parenthesis ends the destination early, so those go in
 * angle brackets; a `<` or `>` inside the URL cannot survive that and is
 * dropped, which is the only lossy case and one no real path has.
 */
export function linkDestination(url: string): string {
  const trimmed = url.trim();
  return /[\s()]/.test(trimmed) ? `<${trimmed.replace(/[<>]/g, '')}>` : trimmed;
}
