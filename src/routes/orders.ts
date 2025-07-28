import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

// Simple helper to remove HTML tags and excess whitespace
const stripHtml = (html: string | null | undefined) => {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
};
// Recursively remove unwanted housekeeping keys from objects/arrays
const stripExtensions = (input: any): any => {
  if (Array.isArray(input)) {
    return input.map(stripExtensions);
  }

  if (input && typeof input === 'object') {
    // Destructure unwanted keys and discard them
    const { extensions, _uniqueIdentifier, versionId, translated, ...rest } = input as Record<string, any>;
    for (const key of Object.keys(rest)) {
      rest[key] = stripExtensions(rest[key]);
    }
    return rest;
  }

  return input;
};

// Build a compact essentials-only view of an order object
const mapEssentials = (order: any) => {
  const firstDelivery = order.deliveries?.[0] ?? {};
  const firstTransaction = order.transactions?.[0] ?? {};

  return {
    customer: {
      orderNumber: order.orderNumber,
      orderDateTime: order.orderDateTime,
      firstName: order.orderCustomer?.firstName,
      lastName: order.orderCustomer?.lastName,
      email: order.orderCustomer?.email,
      customerNumber: order.orderCustomer?.customerNumber,
      salesChannel: order.salesChannel?.name
    },
    status: {
      overall: order.stateMachineState?.name,
      payment: firstTransaction.stateMachineState?.name,
      shipping: firstDelivery.stateMachineState?.name
    },
    shipping: {
      address: firstDelivery.shippingOrderAddress
        ? {
            street: firstDelivery.shippingOrderAddress.street,
            zipcode: firstDelivery.shippingOrderAddress.zipcode,
            city: firstDelivery.shippingOrderAddress.city,
            company: firstDelivery.shippingOrderAddress.company,
            phoneNumber: firstDelivery.shippingOrderAddress.phoneNumber,
            country: firstDelivery.shippingOrderAddress.country?.name
          }
        : null,
      trackingCodes: firstDelivery.trackingCodes ?? [],
      shippingMethod: {
        name: firstDelivery.shippingMethod?.name,
        description: firstDelivery.shippingMethod?.description
      }
    },
    items: (order.lineItems || []).map((li: any) => ({
      name: li.product?.translated?.name ?? li.product?.name ?? li.label,
      description: stripHtml(li.product?.translated?.description ?? li.product?.description),
      productNumber: li.product?.productNumber ?? li.payload?.productNumber ?? li.productId,
      quantity: li.quantity,
      totalPrice: li.totalPrice
    })),
    totals: {
      amountTotal: order.amountTotal,
      shippingTotal: order.shippingTotal,
      paymentMethod: firstTransaction.paymentMethod?.name
    }
  } as const;
};

const route: FastifyPluginAsync = async (fastify) => {
  const querySchema = z.object({
    orderNumber: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(250).default(10).optional()
  });

  fastify.get('/v1/orders/search', {
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
  }, async (request, reply) => {
    const { orderNumber, page, limit } = querySchema.parse(request.query);

    let criteria: any;

    if (orderNumber) {
      criteria = {
        filter: [
          { type: 'equals', field: 'orderNumber', value: orderNumber }
        ],
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
    const cleaned = stripExtensions(result);
    const essentials = {
      total: cleaned.total,
      orders: (cleaned.data || []).map(mapEssentials)
    } as const;

    return essentials;
  });
};

export default route; 