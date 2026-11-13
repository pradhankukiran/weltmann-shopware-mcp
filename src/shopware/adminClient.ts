import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse
} from 'axios';
import { getConfig } from '../config';
import { ShopwareApiError } from '../utils/errors';

export interface ShopwareAdminClientOptions {
  baseUrl: string; // e.g. https://example.com/api
  accessKeyId: string; // integration access key
  secretAccessKey: string; // integration secret
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  token_type: 'Bearer';
}

export class ShopwareAdminClient {
  private readonly opts: ShopwareAdminClientOptions;
  private readonly axios: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0; // epoch ms

  // Token refresh mutex to prevent race conditions
  private tokenRefreshPromise: Promise<string> | null = null;
  private readonly tokenRefreshBufferMs = 5 * 60 * 1000; // 5 minutes before expiry

  // Retry configuration
  private readonly maxRetries = 3;
  private readonly baseDelayMs = 1000;

  constructor(options: ShopwareAdminClientOptions) {
    const config = getConfig();
    this.opts = options;

    this.axios = axios.create({
      baseURL: options.baseUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: config.SHOPWARE_API_TIMEOUT
    });

    this.axios.interceptors.request.use(async (cfg) => {
      const token = await this.getValidToken();
      cfg.headers = cfg.headers || {};
      cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });
  }

  /**
   * Check if an error is retryable (5xx, 401, network errors)
   */
  private isRetryableError(error: unknown): boolean {
    // safePost/safeGet wrap axios errors; look at the original error
    if (error instanceof ShopwareApiError && error.originalError) {
      error = error.originalError;
    }
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      // Retry on network errors and timeouts
      if (!status) {
        return error.code === 'ECONNRESET' ||
               error.code === 'ETIMEDOUT' ||
               error.code === 'ECONNREFUSED';
      }
      // Handle 401 by invalidating token and retrying
      if (status === 401) {
        this.invalidateToken();
        return true;
      }
      // Retry on server errors (5xx)
      return status >= 500;
    }
    return false;
  }

  /**
   * Execute an operation with retry logic and exponential backoff.
   * The whole call, including retries and token refresh, must finish within
   * SHOPWARE_CALL_BUDGET_MS so voice agents are not left waiting.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    const deadline = Date.now() + getConfig().SHOPWARE_CALL_BUDGET_MS;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      try {
        return await this.withDeadline(operation(), remaining, context);
      } catch (error) {
        lastError = error as Error;

        if (!this.isRetryableError(error)) {
          throw error;
        }

        const delay = this.baseDelayMs * Math.pow(2, attempt);
        // Stop if this was the last attempt or there is no time left for another
        if (attempt === this.maxRetries - 1 || Date.now() + delay >= deadline) {
          break;
        }

        // eslint-disable-next-line no-console
        console.warn(
          `[ShopwareAdminClient] ${context} failed (attempt ${attempt + 1}/${this.maxRetries}), retrying in ${delay}ms`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new ShopwareApiError(`${context} timed out`, context);
  }

  /**
   * Reject if the operation does not settle within the given time.
   */
  private withDeadline<T>(promise: Promise<T>, ms: number, context: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ShopwareApiError(`${context} timed out after ${ms}ms`, context)),
        ms
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private async fetchToken(): Promise<OAuthTokenResponse> {
    const url = '/oauth/token';
    const config = getConfig();

    const payload = {
      grant_type: 'client_credentials',
      client_id: this.opts.accessKeyId,
      client_secret: this.opts.secretAccessKey
    } as const;

    try {
      const { data } = await axios.post<OAuthTokenResponse>(
        `${this.opts.baseUrl}${url}`,
        payload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: config.SHOPWARE_API_TIMEOUT
        }
      );
      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const message =
          statusCode === 401
            ? 'Invalid Shopware credentials'
            : `Token fetch failed: ${error.message}`;
        throw new ShopwareApiError(message, url, statusCode, error);
      }
      throw new ShopwareApiError(
        `Token fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        url
      );
    }
  }

  private async getValidToken(): Promise<string> {
    const now = Date.now();
    // Return cached token if still valid (with buffer time)
    if (this.token && now < this.tokenExpiresAt - this.tokenRefreshBufferMs) {
      return this.token;
    }

    // If a refresh is already in progress, wait for it instead of starting another
    if (this.tokenRefreshPromise) {
      return this.tokenRefreshPromise;
    }

    // Start token refresh and store the promise for concurrent callers
    this.tokenRefreshPromise = this.refreshToken();
    try {
      return await this.tokenRefreshPromise;
    } finally {
      this.tokenRefreshPromise = null;
    }
  }

  private async refreshToken(): Promise<string> {
    const tokenResp = await this.fetchToken();
    this.token = tokenResp.access_token;
    this.tokenExpiresAt = Date.now() + tokenResp.expires_in * 1000;
    return this.token;
  }

  /**
   * Invalidate the current token, forcing a refresh on next request
   */
  private invalidateToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Safe POST helper that wraps errors in ShopwareApiError and includes retry logic
   */
  private async safePost<T>(endpoint: string, payload: unknown): Promise<T> {
    return this.withRetry(async () => {
      try {
        const { data } = await this.axios.post<T>(endpoint, payload);
        return data;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const statusCode = error.response?.status;
          const apiError = (error.response?.data as { errors?: Array<{ detail?: string }> })
            ?.errors?.[0]?.detail;
          const message = apiError || error.message;
          throw new ShopwareApiError(
            `API request to ${endpoint} failed: ${message}`,
            endpoint,
            statusCode,
            error
          );
        }
        throw new ShopwareApiError(
          `Request to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
          endpoint
        );
      }
    }, `POST ${endpoint}`);
  }

  // Generic request helper
  async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.request<T>(config);
  }

  // Convenience helpers ----------------------------------
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.get<T>(url, config);
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.axios.post<T>(url, data, config);
  }

  async patch<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.axios.patch<T>(url, data, config);
  }

  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.delete<T>(url, config);
  }

  // Domain helpers ---------------------------------------

  async fetchOrderByOrderNumber(orderNumber: string) {
    const criteria = {
      filter: [
        {
          type: 'equals',
          field: 'orderNumber',
          value: orderNumber
        }
      ],
      associations: {
        lineItems: {},
        deliveries: {
          associations: {
            shippingMethod: {}
          }
        }
      }
    };

    return this.safePost<{ total: number; data: unknown[] }>('/search/order', criteria);
  }

  /**
   * Generic order search helper. Accepts a full Shopware criteria object.
   */
  async searchOrders(criteria: Record<string, unknown>) {
    return this.safePost<{ total: number; data: unknown[] }>('/search/order', criteria);
  }

  /**
   * Look up an order by exact orderNumber.
   */
  async searchOrdersByNumber(orderNumber: string, includeAllFields = false) {
    const payload: Record<string, unknown> = {
      filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }]
    };

    if (!includeAllFields) {
      payload.includes = {
        order: ['id', 'orderNumber', 'orderDateTime', 'amountTotal', 'stateId']
      };
    }

    return this.safePost<{ total: number; data: unknown[] }>('/search/order', payload);
  }

  /**
   * Search products by term with pagination support.
   * Has safety limits to prevent infinite loops.
   */
  async searchProducts(term: string, limit?: number, exact = true, includeAllFields = false) {
    const config = getConfig();

    // If limit is provided, simple one-shot request
    if (typeof limit === 'number') {
      const payload: Record<string, unknown> = {
        term,
        limit,
        ...(exact
          ? {
              filter: [{ type: 'contains', field: 'name', value: term }],
              term: undefined
            }
          : {})
      };

      if (!includeAllFields) {
        payload.includes = {
          product: ['id', 'name', 'productNumber', 'stock', 'active']
        };
      }

      return this.safePost<{ total: number; data: unknown[] }>('/search/product', payload);
    }

    // Otherwise fetch all pages with safety limits
    const pageSize = config.MAX_PAGE_SIZE;
    const maxIterations = config.MAX_PAGINATION_ITERATIONS;
    const maxTotalItems = config.MAX_TOTAL_ITEMS;

    let page = 1;
    let all: unknown[] = [];
    let total = 0;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations += 1;

      const payload: Record<string, unknown> = {
        term: exact ? undefined : term,
        limit: pageSize,
        page,
        ...(exact ? { filter: [{ type: 'contains', field: 'name', value: term }] } : {})
      };

      if (!includeAllFields) {
        payload.includes = {
          product: ['id', 'name', 'productNumber', 'stock', 'active']
        };
      }

      const data = await this.safePost<{ total?: number; data?: unknown[] }>(
        '/search/product',
        payload
      );
      const items = data.data ?? [];
      total = data.total ?? items.length;
      all = all.concat(items);

      // Exit conditions
      if (all.length >= total || items.length === 0) {
        return { total, data: all };
      }

      // Safety: prevent accumulating too many items
      if (all.length >= maxTotalItems) {
        // eslint-disable-next-line no-console
        console.warn(`Pagination stopped: reached ${maxTotalItems} items limit`);
        return { total, data: all };
      }

      page += 1;
    }

    // If we hit max iterations, return what we have
    // eslint-disable-next-line no-console
    console.warn(`Pagination stopped: reached ${maxIterations} page limit`);
    return { total, data: all };
  }

  /**
   * Find product(s) by exact productNumber (SKU).
   */
  async searchProductsByNumber(productNumber: string, includeAllFields = false) {
    const payload: Record<string, unknown> = {
      filter: [{ type: 'equals', field: 'productNumber', value: productNumber }]
    };

    if (!includeAllFields) {
      payload.includes = {
        product: ['id', 'name', 'productNumber', 'stock', 'active']
      };
    }

    return this.safePost<{ total: number; data: unknown[] }>('/search/product', payload);
  }

  /**
   * Generic customer search helper.
   */
  async searchCustomers(criteria: Record<string, unknown>) {
    return this.safePost<{ total: number; data: unknown[] }>('/search/customer', criteria);
  }

  /**
   * Look up customers by email address.
   */
  async searchCustomersByEmail(email: string, includeAllFields = false) {
    const payload: Record<string, unknown> = {
      filter: [{ type: 'equals', field: 'email', value: email }]
    };

    if (!includeAllFields) {
      payload.includes = {
        customer: ['id', 'customerNumber', 'email', 'firstName', 'lastName', 'title', 'active']
      };
    } else {
      payload.associations = {
        defaultBillingAddress: {
          associations: { country: {} }
        },
        defaultShippingAddress: {
          associations: { country: {} }
        },
        addresses: {
          associations: { country: {} }
        }
      };
    }

    return this.safePost<{ total: number; data: unknown[] }>('/search/customer', payload);
  }

  /**
   * Find all orders for a specific customer by customer ID.
   */
  async searchOrdersByCustomer(customerId: string, includeAllFields = false) {
    const payload: Record<string, unknown> = {
      filter: [{ type: 'equals', field: 'orderCustomer.customerId', value: customerId }],
      sort: [{ field: 'orderDateTime', order: 'DESC' }]
    };

    if (!includeAllFields) {
      payload.includes = {
        order: ['id', 'orderNumber', 'orderDateTime', 'amountTotal', 'stateId']
      };
    } else {
      payload.associations = {
        stateMachineState: {},
        transactions: {
          associations: {
            stateMachineState: {},
            paymentMethod: {}
          }
        },
        deliveries: {
          associations: {
            stateMachineState: {},
            shippingMethod: {},
            shippingOrderAddress: {
              associations: { country: {} }
            }
          }
        },
        orderCustomer: {},
        salesChannel: {},
        lineItems: {
          associations: { product: {} }
        }
      };
    }

    return this.safePost<{ total: number; data: unknown[] }>('/search/order', payload);
  }
}
