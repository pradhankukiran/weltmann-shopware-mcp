/**
 * Centralized utility exports
 */

// String utilities
export { stripHtml, normalizeText } from './strings';

// Array utilities
export { first, firstOrThrow, firstOr } from './array';

// Error handling
export { ShopwareApiError, sanitizeErrorForClient, logErrorDetails } from './errors';
export type { SanitizedError } from './errors';

// HTML/XSS utilities
export { escapeHtml, escapeAttr, maskSensitiveUrl } from './html';

// Shopware utilities
export { stripExtensionsDeep, mapOrderEssentials } from './shopware';
