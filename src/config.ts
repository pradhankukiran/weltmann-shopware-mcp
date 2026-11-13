import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  SERVER_HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Shopware API
  SHOPWARE_API_URL: z.string().url(),
  SHOPWARE_ACCESS_KEY_ID: z.string(),
  SHOPWARE_SECRET_ACCESS_KEY: z.string(),
  SHOPWARE_API_TIMEOUT: z.coerce.number().default(8000),
  // Max time for one Shopware call including retries. Keep well under the
  // ElevenLabs tool timeout (30s by default); some tools make two calls.
  SHOPWARE_CALL_BUDGET_MS: z.coerce.number().default(12000),

  // Pagination defaults
  DEFAULT_PAGE_SIZE: z.coerce.number().default(10),
  MAX_PAGE_SIZE: z.coerce.number().default(250),
  MAX_PAGINATION_ITERATIONS: z.coerce.number().default(100),
  MAX_TOTAL_ITEMS: z.coerce.number().default(25000),

  // Health check
  HEALTH_CHECK_PRODUCT_NUMBER: z.string().default('JA-000001'),

  // Security
  MCP_API_KEY: z.string().optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  CORS_ORIGIN: z.string().optional(),

  // MCP tool display limits
  MCP_ORDER_DISPLAY_LIMIT: z.coerce.number().default(10),
  MCP_PRODUCT_DISPLAY_LIMIT: z.coerce.number().default(10),
  MCP_CUSTOMER_SEARCH_LIMIT: z.coerce.number().default(50)
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const config = parsed.data;

  // Production safety check - require API key authentication
  if (config.NODE_ENV === 'production' && !config.MCP_API_KEY) {
    // eslint-disable-next-line no-console
    console.error('SECURITY ERROR: MCP_API_KEY is required in production');
    process.exit(1);
  }
  if (config.NODE_ENV === 'development' && !config.MCP_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn('WARNING: MCP endpoint running without authentication');
  }

  cachedConfig = config;
  return cachedConfig;
}

/**
 * Singleton getter for use in modules that can't easily inject config
 */
export function getConfig(): EnvConfig {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}
