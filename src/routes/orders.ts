import { FastifyPluginAsync } from 'fastify';
import { z, ZodError } from 'zod';
import { stripExtensionsDeep, mapOrderEssentials, logErrorDetails, sanitizeErrorForClient } from '../utils';
import type { ShopwareOrder } from '../types/shopware';

const route: FastifyPluginAsync = async (fastify) => {
  const querySchema = z.object({
    orderNumber: z.string().min(1, 'Order number cannot be empty').optional(),
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(250).default(10).optional()
  });

  fastify.get(
    '/v1/orders/search',
    {
      schema: {
        description: 'Search orders by order number or criteria (raw response from Shopware)',
        querystring: {
          type: 'object',
          properties: {
            orderNumber: { type: 'string' },
            page: { type: 'number', minimum: 1 },
            limit: { type: 'number', minimum: 1, maximum: 250 }
          }
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: true
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { orderNumber, page, limit } = querySchema.parse(request.query);

      let criteria: Record<string, unknown>;

      if (orderNumber) {
        criteria = {
          filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }],
          associations: {
            stateMachineState: {},
            billingAddress: {
              associations: {
                country: {},
                countryState: {},
                salutation: {}
              }
            },
            addresses: {
              associations: {
                country: {},
                countryState: {},
                salutation: {}
              }
            },
            lineItems: {
              associations: {
                product: {
                  associations: {
                    media: {}
                  }
                },
                cover: {}
              }
            },
            language: {},
            salesChannel: {},
            transactions: {
              associations: {
                stateMachineState: {},
                paymentMethod: {
                  associations: {
                    media: {}
                  }
                }
              }
            },
            deliveries: {
              associations: {
                stateMachineState: {},
                shippingMethod: {
                  associations: {
                    deliveryTime: {}
                  }
                },
                shippingOrderAddress: {
                  associations: {
                    country: {},
                    countryState: {},
                    salutation: {}
                  }
                }
              }
            },
            documents: {
              associations: {
                documentType: {}
              }
            }
          }
        };
      } else {
        criteria = {
          page,
          limit,
          associations: {
            stateMachineState: {},
            billingAddress: {
              associations: {
                country: {},
                countryState: {},
                salutation: {}
              }
            },
            addresses: {
              associations: {
                country: {},
                countryState: {},
                salutation: {}
              }
            },
            lineItems: {
              associations: {
                product: {
                  associations: {
                    media: {}
                  }
                },
                cover: {}
              }
            },
            language: {},
            salesChannel: {},
            transactions: {
              associations: {
                stateMachineState: {},
                paymentMethod: {
                  associations: {
                    media: {}
                  }
                }
              }
            },
            deliveries: {
              associations: {
                stateMachineState: {},
                shippingMethod: {
                  associations: {
                    deliveryTime: {}
                  }
                },
                shippingOrderAddress: {
                  associations: {
                    country: {},
                    countryState: {},
                    salutation: {}
                  }
                }
              }
            },
            documents: {
              associations: {
                documentType: {}
              }
            }
          }
        };
      }

      const result = await fastify.shopware.searchOrders(criteria);

        // Remove noisy fields first, then map essentials
        const cleaned = stripExtensionsDeep(result);
        const essentials = {
          total: cleaned.total,
          orders: ((cleaned.data as unknown[]) || []).map((order) =>
            mapOrderEssentials(order as ShopwareOrder)
          )
        } as const;

        return essentials;
      } catch (err: unknown) {
        if (err instanceof ZodError) {
          return reply.code(400).send({
            error: 'Validation error',
            details: err.issues.map((e) => e.message)
          });
        }
        logErrorDetails(fastify.log, err, 'orders-search');
        const sanitized = sanitizeErrorForClient(err);
        return reply.code(500).send({ error: sanitized.message });
      }
    }
  );
};

export default route;
