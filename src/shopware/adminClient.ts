import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  AxiosRequestHeaders
} from 'axios';

export interface ShopwareAdminClientOptions {
  baseUrl: string; // e.g. https://example.com/api
  accessKeyId: string; // integration access key
  secretAccessKey: string; // integration secret
}

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
  token_type: 'Bearer';
  // refresh_token omitted for integrations
}

export class ShopwareAdminClient {
  private readonly opts: ShopwareAdminClientOptions;
  private readonly axios: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0; // epoch ms

  constructor(options: ShopwareAdminClientOptions) {
    this.opts = options;

    this.axios = axios.create({
      baseURL: options.baseUrl,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10_000
    });

    this.axios.interceptors.request.use(async (config) => {
      const token = await this.getValidToken();
      const cfg: any = config;
      cfg.headers = cfg.headers || {};
      cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });
  }

  private async fetchToken(): Promise<OAuthTokenResponse> {
    const url = '/oauth/token';

    const payload = {
      grant_type: 'client_credentials',
      client_id: this.opts.accessKeyId,
      client_secret: this.opts.secretAccessKey
    } as const;

    const { data } = await axios.post<OAuthTokenResponse>(`${this.opts.baseUrl}${url}`, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return data;
  }

  private async getValidToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 30_000) {
      return this.token;
    }

    const tokenResp = await this.fetchToken();
    this.token = tokenResp.access_token;
    this.tokenExpiresAt = now + tokenResp.expires_in * 1000;
    return this.token;
  }

  // Generic request helper
  async request<T = unknown>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.request<T>(config);
  }

  // Convenience helpers ----------------------------------
  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.get<T>(url, config);
  }

  async post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.post<T>(url, data, config);
  }

  async patch<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
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

    const { data } = await this.post<any>('/search/order', criteria);
    return data;
  }

  /**
   * Generic order search helper. Accepts a full Shopware criteria object and returns the raw response.
   * Caller can specify paging, filters, associations, etc.
   */
  async searchOrders(criteria: Record<string, any>) {
    const { data } = await this.post<any>('/search/order', criteria);
    return data;
  }

  /**
   * Convenience helper to look up an order (or orders) by exact orderNumber.
   * Mirrors the product „by number" helper for symmetry.
   */
  async searchOrdersByNumber(orderNumber: string, includeAllFields = false) {
    const payload: any = {
      filter: [
        { type: 'equals', field: 'orderNumber', value: orderNumber }
      ]
    };

    if (!includeAllFields) {
      payload.includes = {
        order: [
          'id',
          'orderNumber',
          'orderDateTime',
          'amountTotal',
          'stateId'
        ]
      };
    }

    const { data } = await this.post<any>('/search/order', payload);
    return data;
  }

  async searchProducts(term: string, limit?: number, exact = true, includeAllFields = false) {
    // If limit is provided, simple one-shot request
    if (typeof limit === 'number') {
      const payload: any = {
        term,
        limit,
        ...(exact
          ? {
              filter: [
                { type: 'contains', field: 'name', value: term }
              ],
              term: undefined
            }
          : {})
      };

      if (!includeAllFields) {
        payload.includes = {
          product: ['id', 'name', 'productNumber', 'stock', 'active']
        };
      }

      const { data } = await this.post<any>('/search/product', payload);
      return data;
    }

    // Otherwise fetch all pages
    const pageSize = 250;
    let page = 1;
    let all: any[] = [];
    let total = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const payload: any = {
        term: exact ? undefined : term,
        limit: pageSize,
        page,
        ...(exact
          ? {
              filter: [
                { type: 'contains', field: 'name', value: term }
              ]
            }
          : {})
      };

      if (!includeAllFields) {
        payload.includes = {
          product: ['id', 'name', 'productNumber', 'stock', 'active']
        };
      }

      const { data } = await this.post<any>('/search/product', payload);
      const items = data.data ?? [];
      total = data.total ?? items.length;
      all = all.concat(items);

      if (all.length >= total || items.length === 0) {
        return { total, data: all };
      }

      page += 1;
    }
  }

  /**
   * Find product(s) by exact productNumber (SKU).
   * Shopware guarantees uniqueness for productNumber but we return an array for symmetry.
   */
  async searchProductsByNumber(productNumber: string, includeAllFields = false) {
    const payload: any = {
      filter: [
        { type: 'equals', field: 'productNumber', value: productNumber }
      ]
    };

    if (!includeAllFields) {
      payload.includes = {
        product: ['id', 'name', 'productNumber', 'stock', 'active']
      };
    }

    const { data } = await this.post<any>('/search/product', payload);
    return data;
  }

  /**
   * Generic customer search helper. Accepts a full Shopware criteria object and returns the raw response.
   * Caller can specify paging, filters, associations, etc.
   */
  async searchCustomers(criteria: Record<string, any>) {
    const { data } = await this.post<any>('/search/customer', criteria);
    return data;
  }

  /**
   * Convenience helper to look up customers by email address.
   */
  async searchCustomersByEmail(email: string, includeAllFields = false) {
    const payload: any = {
      filter: [
        { type: 'equals', field: 'email', value: email }
      ]
    };

    if (!includeAllFields) {
      payload.includes = {
        customer: [
          'id',
          'customerNumber',
          'email',
          'firstName',
          'lastName',
          'title',
          'active'
        ]
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

    const { data } = await this.post<any>('/search/customer', payload);
    return data;
  }

  /**
   * Find all orders for a specific customer by customer ID.
   */
  async searchOrdersByCustomer(customerId: string, includeAllFields = false) {
    const payload: any = {
      filter: [
        { type: 'equals', field: 'orderCustomer.customerId', value: customerId }
      ],
      sort: [
        { field: 'orderDateTime', order: 'DESC' }
      ]
    };

    if (!includeAllFields) {
      payload.includes = {
        order: [
          'id',
          'orderNumber',
          'orderDateTime',
          'amountTotal',
          'stateId'
        ]
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

    const { data } = await this.post<any>('/search/order', payload);
    return data;
  }
} 