/**
 * String manipulation utilities
 */

/**
 * Remove HTML tags and normalize whitespace from a string.
 * Handles null/undefined gracefully.
 */
export function stripHtml(html: string | null | undefined): string {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<[^>]*>/g, ' ')     // strip HTML tags
    .replace(/\r?\n|\r/g, ' ')    // replace CR/LF with spaces
    .replace(/\s{2,}/g, ' ')      // collapse multiple spaces
    .trim();
}

/**
 * Normalize text for comparison: lowercase, remove accents
 */
export function normalizeText(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
