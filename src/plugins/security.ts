/**
 * Security middleware plugin for MCP endpoint
 * - Optional API key authentication
 * - Rate limiting
 */

import crypto from 'crypto';

import { FastifyPluginAsync, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

export interface RateLimitConfig {
  windowMs: number;      // Time window in ms (e.g., 60000 for 1 minute)
  maxRequests: number;   // Max requests per window
}

export interface SecurityConfig {
  rateLimit: RateLimitConfig;
  apiKey?: string;       // Optional API key for authentication
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Simple in-memory rate limiter (production would use Redis for distributed systems)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup interval reference for proper shutdown
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Pads both buffers to the same length for constant-time comparison.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  const maxLen = Math.max(aBuffer.length, bBuffer.length);
  const aPadded = Buffer.alloc(maxLen, 0);
  const bPadded = Buffer.alloc(maxLen, 0);
  aBuffer.copy(aPadded);
  bBuffer.copy(bPadded);

  const lengthsEqual = aBuffer.length === bBuffer.length;
  const contentsEqual = crypto.timingSafeEqual(aPadded, bPadded);
  return lengthsEqual && contentsEqual;
}

export const registerSecurity: FastifyPluginAsync<SecurityConfig> = fp(
  async (fastify: FastifyInstance, opts: SecurityConfig) => {
    const { rateLimit, apiKey } = opts;

    // Rate limiting and auth hook for /mcp endpoint
    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
      // Only apply to /mcp endpoint
      if (!request.url.startsWith('/mcp')) return;

      // Optional API key authentication
      if (apiKey) {
        const providedKey =
          request.headers['x-api-key'] ||
          (request.headers['authorization']?.replace('Bearer ', '') ?? '');

        if (!timingSafeCompare(String(providedKey), apiKey)) {
          reply.code(401).send({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null
          });
          return;
        }
      }

      // Rate limiting
      const clientIp = request.ip || 'unknown';
      const now = Date.now();
      const clientData = rateLimitStore.get(clientIp);

      if (!clientData || now > clientData.resetAt) {
        // New window or expired - reset
        rateLimitStore.set(clientIp, {
          count: 1,
          resetAt: now + rateLimit.windowMs
        });
      } else {
        // Existing window - increment
        clientData.count++;

        if (clientData.count > rateLimit.maxRequests) {
          const retryAfter = Math.ceil((clientData.resetAt - now) / 1000);
          reply
            .code(429)
            .header('Retry-After', retryAfter)
            .send({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`
              },
              id: null
            });
          return;
        }
      }
    });

    // Cleanup old entries periodically to prevent memory leaks
    cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of rateLimitStore.entries()) {
        if (now > value.resetAt) {
          rateLimitStore.delete(key);
        }
      }
    }, 60000); // Clean every minute

    // Cleanup on server close
    fastify.addHook('onClose', async () => {
      if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
      }
      rateLimitStore.clear();
    });

    fastify.log.info(
      apiKey
        ? 'Security middleware registered (API key auth + rate limiting)'
        : 'Security middleware registered (rate limiting only)'
    );
  },
  {
    name: 'security-plugin'
  }
);
