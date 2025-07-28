"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShopwareAdminClient = void 0;
const axios_1 = __importDefault(require("axios"));
class ShopwareAdminClient {
    constructor(options) {
        this.token = null;
        this.tokenExpiresAt = 0; // epoch ms
        this.opts = options;
        this.axios = axios_1.default.create({
            baseURL: options.baseUrl,
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        this.axios.interceptors.request.use(async (config) => {
            const token = await this.getValidToken();
            const cfg = config;
            cfg.headers = cfg.headers || {};
            cfg.headers.Authorization = `Bearer ${token}`;
            return cfg;
        });
    }
    async fetchToken() {
        const url = '/oauth/token';
        const payload = {
            grant_type: 'client_credentials',
            client_id: this.opts.accessKeyId,
            client_secret: this.opts.secretAccessKey
        };
        const { data } = await axios_1.default.post(`${this.opts.baseUrl}${url}`, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        return data;
    }
    async getValidToken() {
        const now = Date.now();
        if (this.token && now < this.tokenExpiresAt - 30000) {
            return this.token;
        }
        const tokenResp = await this.fetchToken();
        this.token = tokenResp.access_token;
        this.tokenExpiresAt = now + tokenResp.expires_in * 1000;
        return this.token;
    }
    // Generic request helper
    async request(config) {
        return this.axios.request(config);
    }
    // Convenience helpers ----------------------------------
    async get(url, config) {
        return this.axios.get(url, config);
    }
    async post(url, data, config) {
        return this.axios.post(url, data, config);
    }
    async patch(url, data, config) {
        return this.axios.patch(url, data, config);
    }
    async delete(url, config) {
        return this.axios.delete(url, config);
    }
    // Domain helpers ---------------------------------------
    async fetchOrderByOrderNumber(orderNumber) {
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
        const { data } = await this.post('/search/order', criteria);
        return data;
    }
    /**
     * Generic order search helper. Accepts a full Shopware criteria object and returns the raw response.
     * Caller can specify paging, filters, associations, etc.
     */
    async searchOrders(criteria) {
        const { data } = await this.post('/search/order', criteria);
        return data;
    }
    /**
     * Convenience helper to look up an order (or orders) by exact orderNumber.
     * Mirrors the product „by number" helper for symmetry.
     */
    async searchOrdersByNumber(orderNumber, includeAllFields = false) {
        const payload = {
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
        const { data } = await this.post('/search/order', payload);
        return data;
    }
    async searchProducts(term, limit, exact = true, includeAllFields = false) {
        // If limit is provided, simple one-shot request
        if (typeof limit === 'number') {
            const payload = {
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
            const { data } = await this.post('/search/product', payload);
            return data;
        }
        // Otherwise fetch all pages
        const pageSize = 250;
        let page = 1;
        let all = [];
        let total = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const payload = {
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
            const { data } = await this.post('/search/product', payload);
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
    async searchProductsByNumber(productNumber, includeAllFields = false) {
        const payload = {
            filter: [
                { type: 'equals', field: 'productNumber', value: productNumber }
            ]
        };
        if (!includeAllFields) {
            payload.includes = {
                product: ['id', 'name', 'productNumber', 'stock', 'active']
            };
        }
        const { data } = await this.post('/search/product', payload);
        return data;
    }
}
exports.ShopwareAdminClient = ShopwareAdminClient;
