import { FastifyPluginAsync } from 'fastify';
import { z, ZodError } from 'zod';
import { stripHtml, logErrorDetails, sanitizeErrorForClient } from '../utils';

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'string' } }
  }
} as const;

const route: FastifyPluginAsync = async (fastify) => {
  const querySchema = z.object({
    term: z.string().min(2, 'Search term must be at least 2 characters').optional(),
    productNumber: z.string().min(1, 'Product number cannot be empty').optional(),
    limit: z.coerce.number().min(1).max(500).optional(),
    exact: z.coerce.boolean().default(true).optional()
  });

  fastify.get(
    '/v1/products/search',
    {
      schema: {
        description: 'Search products by keyword',
        querystring: {
          type: 'object',
          properties: {
            term: { type: 'string' },
            productNumber: { type: 'string' },
            limit: { type: 'number' },
            exact: { type: 'boolean' }
          }
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
          },
          400: errorResponseSchema,
          500: errorResponseSchema
        }
      }
    },
    async (request, reply) => {
      try {
        const { term, productNumber, limit, exact } = querySchema.parse(request.query);

        let result: { total: number; data: unknown[] };
        if (productNumber) {
          result = await fastify.shopware.searchProductsByNumber(productNumber, true);
        } else if (term) {
          result = await fastify.shopware.searchProducts(term, limit, exact, true);
        } else {
          return reply.code(400).send({ error: 'Either term or productNumber must be provided' });
        }

        const products = ((result?.data || []) as Array<Record<string, unknown>>).map((p) => {
          const translated = p.translated as Record<string, unknown> | undefined;
          return {
            name: (translated?.name as string) ?? (p.name as string) ?? '',
            description: stripHtml((translated?.description as string) ?? (p.description as string)),
            availableStock: (p.availableStock as number) ?? (p.stock as number) ?? null
          };
        });

        return {
          total: result.total ?? products.length,
          products
        } as const;
      } catch (err: unknown) {
        if (err instanceof ZodError) {
          return reply.code(400).send({
            error: 'Validation error',
            details: err.issues.map((e) => e.message)
          });
        }
        logErrorDetails(fastify.log, err, 'products-search');
        const sanitized = sanitizeErrorForClient(err);
        return reply.code(500).send({ error: sanitized.message });
      }
    }
  );
};

export default route;
