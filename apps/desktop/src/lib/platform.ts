/**
 * Cmd on macOS, Ctrl on Windows and Linux, throughout (design 4.1). The
 * platform is read once at startup; tests pass the flag explicitly.
 */
export function detectMac(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false;
  return /mac|iphone|ipad/i.test(nav.platform || nav.userAgent || '');
}

export const isMac = detectMac(globalThis.navigator);
