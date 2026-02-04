/**
 * HTML escaping utilities for XSS prevention
 */

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(unsafe: string | number | null | undefined): string {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escape value for use in HTML attribute
 */
export function escapeAttr(unsafe: string | number | null | undefined): string {
  return escapeHtml(unsafe);
}

/**
 * Mask a URL to hide sensitive parts of the hostname
 */
export function maskSensitiveUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.length > 10) {
      parsed.hostname = host.substring(0, 3) + '*****' + host.substring(host.length - 6);
    }
    return parsed.toString();
  } catch {
    return '(configured)';
  }
}
