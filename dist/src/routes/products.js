"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
// Very small helper to remove HTML tags (e.g. <p>, <br/>) from strings.
// Not perfect for every edge-case but good enough for simple product descriptions.
const stripHtml = (html) => {
    if (typeof html !== 'string')
        return '';
    return html
        .replace(/<[^>]*>/g, ' ') // strip HTML tags
        .replace(/\r?\n|\r/g, ' ') // replace CR/LF with spaces
        .replace(/\s{2,}/g, ' ') // collapse multiple spaces
        .trim();
};
const route = async (fastify) => {
    const querySchema = zod_1.z.object({
        term: zod_1.z.string().optional(),
        productNumber: zod_1.z.string().optional(),
        limit: zod_1.z.coerce.number().optional(),
        exact: zod_1.z.coerce.boolean().default(true).optional()
    });
    fastify.get('/v1/products/search', {
        schema: {
            description: 'Search products by keyword',
            querystring: {
                type: 'object',
                properties: {
                    term: { type: 'string' },
                    productNumber: { type: 'string' },
                    limit: { type: 'number' },
                    exact: { type: 'boolean' }
                },
                required: ['term']
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        total: { type: 'number' },
                        products: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' },
                                    description: { type: 'string' },
                                    availableStock: { type: 'number' }
                                },
                                required: ['name'],
                                additionalProperties: false
                            }
                        }
                    }
                }
            }
        }
    }, async (request, reply) => {
        const { term, productNumber, limit, exact } = querySchema.parse(request.query);
        let result;
        if (productNumber) {
            result = await fastify.shopware.searchProductsByNumber(productNumber, true);
        }
        else if (term) {
            result = await fastify.shopware.searchProducts(term, limit, exact, true);
        }
        else {
            return reply.code(400).send({ error: 'Either term or productNumber must be provided' });
        }
        const products = (result?.data || []).map((p) => ({
            name: p.name,
            description: stripHtml(p.description),
            availableStock: p.availableStock ?? p.stock ?? null
        }));
        return {
            total: result.total ?? products.length,
            products
        };
    });
};
exports.default = route;
