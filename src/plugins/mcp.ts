import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Product } from './csv';
import {
  stripHtml,
  normalizeText,
  first,
  stripExtensionsDeep,
  mapOrderEssentials,
  sanitizeErrorForClient,
  logErrorDetails
} from '../utils';
import { getConfig } from '../config';

// Helper to attach tools to a given server instance
const registerTools = (fastifyInstance: FastifyInstance, serverInstance: McpServer) => {
  const config = getConfig();

  // Helper to create properly typed text content blocks
  const textContent = (text: string): Array<{ type: 'text'; text: string }> => [
    { type: 'text' as const, text }
  ];

  // Helper to create response with both text and structured content (MCP 2025-11-25 spec)
  const structuredResponse = <T extends Record<string, unknown>>(
    text: string,
    data: T
  ): { content: Array<{ type: 'text'; text: string }>; structuredContent: T } => ({
    content: textContent(text),
    structuredContent: data
  });

  // Helper for error responses with structured content
  const errorResponse = (
    message: string,
    errorType: string = 'error'
  ): { isError: true; content: Array<{ type: 'text'; text: string }>; structuredContent: { error: string; errorType: string } } => ({
    isError: true,
    content: textContent(message),
    structuredContent: { error: message, errorType }
  });

  // Helper for not found responses
  const notFoundResponse = (
    entityType: string,
    identifier: string
  ): { content: Array<{ type: 'text'; text: string }>; structuredContent: { found: false; entityType: string; identifier: string } } => ({
    content: textContent(`${entityType} "${identifier}" not found.`),
    structuredContent: { found: false, entityType, identifier }
  });

  const inputShape = {
    productNumber: z.string().min(1, 'Product number is required')
  } as const;

  const outputShape = {
    total: z.number(),
    products: z.array(
      z.object({
        productNumber: z.string(),
        name: z.string(),
        description: z.string().optional(),
        availableStock: z.number().nullable()
      })
    )
  } as const;

  // -------------------- Order search tool --------------------
  const orderInputShape = {
    orderNumber: z.string().min(1, 'Order number cannot be empty').optional(),
    page: z.number().min(1).optional(),
    limit: z.number().min(1).max(250).optional()
  } as const;

  // Address schema - proper typed object instead of z.any()
  const addressShape = z.object({
    street: z.string().nullable().optional(),
    zipcode: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    company: z.string().nullable().optional(),
    phoneNumber: z.string().nullable().optional(),
    country: z.string().nullable().optional()
  }).nullable();

  const orderOutputShape = {
    total: z.number(),
    orders: z.array(
      z.object({
        customer: z.object({
          orderNumber: z.string(),
          orderDateTime: z.string(),
          firstName: z.string().nullable(),
          lastName: z.string().nullable(),
          email: z.string().nullable(),
          customerNumber: z.string().nullable(),
          salesChannel: z.string().nullable()
        }),
        status: z.object({
          overall: z.string().nullable(),
          payment: z.string().nullable(),
          shipping: z.string().nullable()
        }),
        shipping: z.object({
          address: addressShape,
          trackingCodes: z.array(z.string()).nullable(),
          shippingMethod: z.object({
            name: z.string().nullable(),
            description: z.string().nullable()
          })
        }),
        items: z.array(
          z.object({
            name: z.string().nullable(),
            description: z.string().nullable(),
            productNumber: z.string().nullable(),
            quantity: z.number(),
            totalPrice: z.number()
          })
        ),
        totals: z.object({
          amountTotal: z.number().nullable(),
          shippingTotal: z.number().nullable(),
          paymentMethod: z.string().nullable()
        })
      })
    )
  } as const;

  serverInstance.registerTool(
    'search-orders',
    {
      title: 'Search orders',
      description: 'Find orders by number or list recent ones',
      inputSchema: orderInputShape,
      outputSchema: orderOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ orderNumber, page, limit }: { orderNumber?: string; page?: number; limit?: number }) => {
      try {
        const criteria: Record<string, unknown> = orderNumber
          ? {
              filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }]
            }
          : {
              page: page || 1,
              limit: limit || config.DEFAULT_PAGE_SIZE
            };

        // Always include associations for essentials (with limits to prevent huge payloads)
        criteria.associations = {
          stateMachineState: {},
          transactions: {
            limit: 10,
            associations: {
              stateMachineState: {},
              paymentMethod: {}
            }
          },
          deliveries: {
            limit: 20,
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
            limit: 100,
            associations: { product: {} }
          }
        };

        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);
        const essentials = {
          total: cleaned.total,
          orders: ((cleaned.data as unknown[]) || []).map((o) => mapOrderEssentials(o as Parameters<typeof mapOrderEssentials>[0]))
        } as const;

        // Handle no match
        if (orderNumber && essentials.total === 0) {
          return notFoundResponse('Order', orderNumber);
        }

        // If a specific order requested and found, provide shipping status summary
        if (orderNumber && essentials.total === 1) {
          const ord = essentials.orders[0];
          const addr = ord.shipping.address;
          const addressLine = addr
            ? `${addr.street}, ${addr.zipcode} ${addr.city}, ${addr.country ?? ''}`.trim()
            : 'n/a';
          const trackingTxt =
            ord.shipping.trackingCodes && ord.shipping.trackingCodes.length > 0
              ? ord.shipping.trackingCodes.join(', ')
              : 'not yet assigned';

          const displayItems = ord.items.slice(0, config.MCP_ORDER_DISPLAY_LIMIT);
          const itemLines = displayItems
            .map(
              (it) =>
                `${it.quantity} × ${it.name} (PN: ${it.productNumber ?? 'n/a'}) – ${it.totalPrice}`
            )
            .join('\n');

          return structuredResponse(
            `Order #${orderNumber} shipping status: ${ord.status.shipping ?? 'n/a'}\n` +
            `Shipping method: ${ord.shipping.shippingMethod.name ?? 'n/a'} – ${ord.shipping.shippingMethod.description ?? ''}\n` +
            `Address: ${addressLine}\n` +
            `Tracking: ${trackingTxt}\n` +
            `Items:\n${itemLines}${ord.items.length > displayItems.length ? '\n…and more' : ''}`,
            { total: 1, orders: [ord] }
          );
        }

        // Generic list response
        const displayOrders = essentials.orders.slice(0, config.MCP_ORDER_DISPLAY_LIMIT);
        const listLines = displayOrders
          .map((o) => `#${o.customer.orderNumber} – ${o.customer.orderDateTime}`)
          .join('\n');

        return structuredResponse(
          `Found ${essentials.total} order(s).\n${listLines}${
            essentials.total > displayOrders.length ? '\n…and more' : ''
          }\nProvide an orderNumber to get a specific order.`,
          { total: essentials.total, orders: displayOrders }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'search-orders');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Order search failed: ${sanitized.message}`, 'search_error');
      }
    }
  );

  // -------------------- Product search tool (by product number) --------------------
  serverInstance.registerTool(
    'search-product-number',
    {
      title: 'Search product by number',
      description: 'Search for a product by its product number',
      inputSchema: inputShape,
      outputSchema: outputShape,
      annotations: { readOnlyHint: true }
    },
    async ({ productNumber }: { productNumber: string }) => {
      try {
        const result = await fastifyInstance.shopware.searchProductsByNumber(productNumber, true);

        const products = ((result?.data || []) as Array<Record<string, unknown>>).map((p) => ({
          name: ((p.translated as Record<string, unknown>)?.name as string) ?? (p.name as string) ?? '',
          productNumber: p.productNumber as string,
          description: stripHtml(
            ((p.translated as Record<string, unknown>)?.description as string) ??
              (p.description as string)
          ),
          availableStock: (p.availableStock as number) ?? (p.stock as number) ?? null
        }));

        const total = result.total ?? products.length;

        if (total > 1) {
          const displayProducts = products.slice(0, config.MCP_PRODUCT_DISPLAY_LIMIT);
          const shortlist = displayProducts.map((p, idx) => `${idx + 1}. ${p.name}`).join('\n');

          return structuredResponse(
            `I found ${total} matching products. Which one are you interested in? Please reply with the list number (1-${displayProducts.length}) or the product name.\n${shortlist}${
              total > displayProducts.length ? '\n…and more' : ''
            }`,
            { total, products: displayProducts }
          );
        }

        if (total === 0) {
          return structuredResponse(
            `Couldn't find any item for "${productNumber}". Could you check the product number for any missing underscores, hyphens or dots?`,
            { total: 0, products: [], searchedProductNumber: productNumber }
          );
        }

        if (total === 1) {
          const p = products[0];
          let description = p.description || '';
          if (description.length > 250) {
            description = `${description.substring(0, 250)}…`;
          }
          const descriptionTxt = description ? `\n\n${description}` : '';

          return structuredResponse(
            `**${p.name}**${descriptionTxt}`.trim(),
            { total: 1, products: [p] }
          );
        }

        const detailLines = products.map((p) => `${p.name}`);

        return structuredResponse(
          `Found ${total} product(s):\n${detailLines.join('\n')}`,
          { total, products }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'search-product-number');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Product search failed: ${sanitized.message}`, 'search_error');
      }
    }
  );

  // -------------------- Stock level tool --------------------
  serverInstance.registerTool(
    'get-stock-level',
    {
      title: 'Get stock level',
      description: 'Return the available stock for a product identified by its product number',
      inputSchema: {
        productNumber: z.string().min(1).describe('The product number (SKU) to check')
      },
      outputSchema: {
        productNumber: z.string(),
        availableStock: z.number().nullable()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ productNumber }: { productNumber: string }) => {
      try {
        const result = await fastifyInstance.shopware.searchProductsByNumber(productNumber, true);

        if (!result || (result.total ?? 0) === 0) {
          return notFoundResponse('Product', productNumber);
        }

        const product = first(result.data as unknown[]) as Record<string, unknown> | undefined;
        if (!product) {
          return notFoundResponse('Product', productNumber);
        }

        const availableStock: number | null =
          (product.availableStock as number) ?? (product.stock as number) ?? null;

        const stockTxt = availableStock != null ? `${availableStock}` : 'n/a';

        return structuredResponse(
          `${stockTxt} units are available.`.trim(),
          { productNumber, availableStock, inStock: availableStock !== null && availableStock > 0 }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'get-stock-level');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Stock check failed: ${sanitized.message}`, 'stock_check_error');
      }
    }
  );

  // -------------------- Order status tool --------------------
  serverInstance.registerTool(
    'check-order-status',
    {
      title: 'Check order status',
      description:
        'Return a customer-friendly order status and delivery estimate for a given order number',
      inputSchema: {
        orderNumber: z.string().min(1).describe('The order number to check')
      },
      outputSchema: {
        orderNumber: z.string(),
        statusText: z.string(),
        deliveryEstimate: z.string().nullable()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ orderNumber }: { orderNumber: string }) => {
      try {
        const criteria = {
          filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }],
          associations: {
            stateMachineState: {},
            deliveries: {
              associations: {
                stateMachineState: {},
                shippingMethod: {},
                shippingOrderAddress: {
                  associations: { country: {} }
                }
              }
            }
          }
        } as const;

        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);

        if (cleaned.total === 0) {
          return notFoundResponse('Order', orderNumber);
        }

        const orderData = first(cleaned.data as unknown[]);
        if (!orderData) {
          return notFoundResponse('Order', orderNumber);
        }

        const essential = mapOrderEssentials(orderData as Parameters<typeof mapOrderEssentials>[0]);

        const getCustomerFriendlyStatus = (status: { shipping?: string | null; overall?: string | null }) => {
          const shippingRaw = (status.shipping ?? status.overall ?? 'unknown').toString();
          const shipping = shippingRaw.toLowerCase();
          switch (shipping) {
            case 'open':
            case 'in progress':
              return 'Your order has been received and is currently being processed.';
            case 'partially shipped':
            case 'shipped':
            case 'completed':
            case 'teilversandt':
            case 'versandt':
            case 'abgeschlossen':
              return 'Good news! Your order has already been shipped.';
            case 'cancelled':
            case 'storniert':
              return 'Unfortunately, this order has been cancelled.';
            case 'returned':
            case 'retour':
              return 'This order was returned to us.';
            default:
              return `Current status: ${shippingRaw}`;
          }
        };

        const calculateDeliveryEstimate = (_order: typeof essential): string | null => {
          const shippingState = (_order.status.shipping ?? _order.status.overall ?? '')
            .toString()
            .toLowerCase();
          if (!shippingState) return null;

          const shippedStates = [
            'shipped',
            'versandt',
            'teilversandt',
            'partially shipped',
            'completed',
            'abgeschlossen'
          ];

          if (shippedStates.includes(shippingState)) {
            return 'Usually delivered within 2–5 business days.';
          }

          return null;
        };

        const statusText = getCustomerFriendlyStatus(essential.status);
        const deliveryEstimate = calculateDeliveryEstimate(essential);
        const rawStatus = essential.status.shipping ?? essential.status.overall ?? 'unknown';

        return structuredResponse(
          `**Order #${orderNumber}**\n${statusText}${deliveryEstimate ? `\nEstimated delivery: ${deliveryEstimate}` : ''}`,
          { orderNumber, statusText, rawStatus, deliveryEstimate, shippingStatus: essential.status.shipping, overallStatus: essential.status.overall }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'check-order-status');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Order status check failed: ${sanitized.message}`, 'status_check_error');
      }
    }
  );

  // -------------------- Payment status tool --------------------
  serverInstance.registerTool(
    'check-payment-status',
    {
      title: 'Check payment status',
      description: 'Return a customer-friendly payment status for a given order number',
      inputSchema: {
        orderNumber: z.string().min(1).describe('The order number to check')
      },
      outputSchema: {
        orderNumber: z.string(),
        paymentStatusText: z.string(),
        paymentMethod: z.string().nullable()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ orderNumber }: { orderNumber: string }) => {
      try {
        const criteria = {
          filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }],
          associations: {
            transactions: {
              associations: {
                stateMachineState: {},
                paymentMethod: {}
              }
            }
          }
        } as const;

        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);

        if (cleaned.total === 0) {
          return notFoundResponse('Order', orderNumber);
        }

        const order = first(cleaned.data as unknown[]) as Record<string, unknown> | undefined;
        if (!order) {
          return notFoundResponse('Order', orderNumber);
        }

        const transactions = order.transactions as Array<Record<string, unknown>> | undefined;
        const firstTx = first(transactions) ?? {};
        const stateMachineState = firstTx.stateMachineState as Record<string, unknown> | undefined;
        const paymentStateRaw = (stateMachineState?.name as string) ?? 'unknown';
        const paymentState = paymentStateRaw.toString().toLowerCase();

        const paymentMethod = firstTx.paymentMethod as Record<string, unknown> | undefined;
        const paymentMethodName: string | null = (paymentMethod?.name as string) ?? null;

        const getFriendlyPaymentStatus = (state: string) => {
          switch (state) {
            case 'open':
            case 'in_progress':
            case 'in progress':
            case 'pending':
            case 'offen':
              return 'Payment is still pending.';
            case 'paid':
            case 'completed':
            case 'bezahlt':
            case 'abgeschlossen':
              return 'Payment received. Thank you!';
            case 'cancelled':
            case 'canceled':
            case 'storniert':
              return 'The payment was cancelled.';
            case 'refunded':
            case 're-credited':
            case 'erstattet':
              return 'The payment was refunded.';
            default:
              return `Current payment status: ${paymentStateRaw}`;
          }
        };

        const paymentStatusText = getFriendlyPaymentStatus(paymentState);
        const methodLine = paymentMethodName ? `Payment method: ${paymentMethodName}\n` : '';
        const isPaid = ['paid', 'completed', 'bezahlt', 'abgeschlossen'].includes(paymentState);

        return structuredResponse(
          `**Order #${orderNumber}**\n${paymentStatusText}\n${methodLine}`.trimEnd(),
          { orderNumber, paymentStatusText, rawStatus: paymentStateRaw, paymentMethod: paymentMethodName, isPaid }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'check-payment-status');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Payment status check failed: ${sanitized.message}`, 'payment_check_error');
      }
    }
  );

  // -------------------- Order items tool --------------------
  serverInstance.registerTool(
    'get-order-items',
    {
      title: 'Get order items',
      description:
        'Return the list of items (name, SKU, quantity, price) for a given order number',
      inputSchema: {
        orderNumber: z.string().min(1).describe('The order number to retrieve items for')
      },
      outputSchema: {
        orderNumber: z.string(),
        items: z.array(
          z.object({
            name: z.string().nullable(),
            productNumber: z.string().nullable(),
            quantity: z.number(),
            totalPrice: z.number()
          })
        )
      },
      annotations: { readOnlyHint: true }
    },
    async ({ orderNumber }: { orderNumber: string }) => {
      try {
        const criteria = {
          filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }],
          associations: {
            lineItems: {
              associations: { product: {} }
            }
          }
        } as const;

        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);

        if (cleaned.total === 0) {
          return notFoundResponse('Order', orderNumber);
        }

        const orderData = first(cleaned.data as unknown[]) as Record<string, unknown> | undefined;
        if (!orderData) {
          return notFoundResponse('Order', orderNumber);
        }

        const lineItems = (orderData.lineItems as Array<Record<string, unknown>>) || [];
        const items = lineItems.map((li) => {
          const product = li.product as Record<string, unknown> | undefined;
          const translated = product?.translated as Record<string, unknown> | undefined;
          const payload = li.payload as Record<string, unknown> | undefined;

          return {
            name:
              (translated?.name as string) ??
              (product?.name as string) ??
              (li.label as string) ??
              null,
            productNumber:
              (product?.productNumber as string) ??
              (payload?.productNumber as string) ??
              null,
            quantity: li.quantity as number,
            totalPrice: li.totalPrice as number
          };
        });

        const itemsLines = items
          .map((it) => `${it.quantity} × ${it.name ?? 'n/a'} – ${it.totalPrice}`)
          .join('\n');

        const totalQuantity = items.reduce((sum, it) => sum + it.quantity, 0);
        const totalValue = items.reduce((sum, it) => sum + it.totalPrice, 0);

        return structuredResponse(
          `Items for order #${orderNumber}:\n${itemsLines}`,
          { orderNumber, items, itemCount: items.length, totalQuantity, totalValue }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'get-order-items');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Order items retrieval failed: ${sanitized.message}`, 'items_retrieval_error');
      }
    }
  );

  // -------------------- Product name search tool --------------------
  serverInstance.registerTool(
    'search-product-catalog',
    {
      title: 'Search product by name',
      description:
        'Search over product names from CSV catalog. Accepts either structured vehicle parameters or a single vehicleText to parse automatically.',
      inputSchema: {
        name: z
          .string()
          .min(2, 'Search term must be at least 2 characters')
          .describe('Partial or full product name'),
        limit: z.number().min(1).max(100).optional().describe('Maximum results to return'),
        vehicleBrand: z.string().max(100).optional().describe('Vehicle brand to filter results'),
        vehicleModel: z.string().max(100).optional().describe('Vehicle model to filter results'),
        vehicleVariant: z.string().max(200).optional().describe('Vehicle variant to filter results'),
        vehicleText: z
          .string()
          .max(300)
          .optional()
          .describe(
            'Full vehicle description (e.g., "citroen c5 limousine") - will be parsed automatically'
          )
      },
      outputSchema: {
        total: z.number(),
        products: z
          .array(
            z.object({
              productNumber: z.string(),
              name: z.string(),
              vehicleBrand: z.string(),
              vehicleModel: z.string(),
              vehicleVariant: z.string()
            })
          )
          .describe('List of matching products with vehicle details')
      },
      annotations: { readOnlyHint: true }
    },
    async ({
      name,
      limit,
      vehicleBrand,
      vehicleModel,
      vehicleVariant,
      vehicleText
    }: {
      name: string;
      limit?: number;
      vehicleBrand?: string;
      vehicleModel?: string;
      vehicleVariant?: string;
      vehicleText?: string;
    }) => {
      try {
        // Parse vehicle information from vehicleText if provided
        let parsedBrand = vehicleBrand;
        let parsedModel = vehicleModel;
        let parsedVariant = vehicleVariant;

        if (vehicleText) {
          const vehicleParts = vehicleText.trim().split(/\s+/);
          if (vehicleParts.length < 2) {
            // Return helpful error instead of silently proceeding
            return structuredResponse(
              'Please provide at least a brand and model in vehicleText (e.g., "citroen c5 limousine")',
              { total: 0, products: [], validationError: 'vehicleText requires at least brand and model' }
            );
          }
          parsedBrand = parsedBrand || vehicleParts[0];
          parsedModel = parsedModel || vehicleParts[1];
          if (!parsedVariant && vehicleParts.length > 2) {
            parsedVariant = vehicleParts.slice(2).join(' ');
          }
        }

        parsedBrand = parsedBrand?.trim();
        parsedModel = parsedModel?.trim();
        parsedVariant = parsedVariant?.trim();

        // Get all products from CSV
        const allProductsCSV = fastifyInstance.products;

        // Filter products by name
        const searchWords = name
          .toLowerCase()
          .split(/\s+/)
          .filter((word: string) => word.length > 1);
        let hits = allProductsCSV.filter((p: Product) => {
          const productNameLower = normalizeText(p.productName);
          return searchWords.every((word: string) => productNameLower.includes(word.toLowerCase()));
        });

        // Filter by brand
        const normalizedBrand = normalizeText(parsedBrand);
        if (normalizedBrand) {
          hits = hits.filter((p: Product) =>
            normalizeText(p.vehicleBrand).includes(normalizedBrand)
          );
        }

        // Filter by model
        const normalizedModel = normalizeText(parsedModel);
        if (normalizedModel) {
          hits = hits.filter((p: Product) =>
            normalizeText(p.vehicleModel).includes(normalizedModel)
          );
        }

        // Filter by variant
        if (parsedVariant) {
          const normalizedVariant = normalizeText(parsedVariant);
          if (normalizedVariant) {
            const baseVariantTerms = ['standard', 'base', 'basic', 'base variant'];
            const normalizedVariantTerms = baseVariantTerms.map((term) => normalizeText(term));
            const isBaseVariantRequest = normalizedVariantTerms.some((term) =>
              normalizedVariant.includes(term)
            );

            if (isBaseVariantRequest) {
              hits = hits.filter((p: Product) => !p.vehicleVariant || !p.vehicleVariant.trim());
            } else {
              hits = hits.filter((p: Product) =>
                normalizeText(p.vehicleVariant).includes(normalizedVariant)
              );
            }
          }
        }

        const allProducts = hits.map((p: Product) => ({
          productNumber: p.productNumber,
          name: p.productName,
          vehicleBrand: p.vehicleBrand ?? '',
          vehicleModel: p.vehicleModel ?? '',
          vehicleVariant: p.vehicleVariant ?? ''
        }));
        const total = allProducts.length;

        let parsedLimit = typeof limit === 'number' ? limit : undefined;
        if (parsedLimit === undefined && typeof limit === 'string') {
          const numericLimit = Number.parseInt(limit, 10);
          if (!Number.isNaN(numericLimit)) {
            parsedLimit = numericLimit;
          }
        }
        const safeLimit = Math.min(Math.max(parsedLimit ?? 20, 1), 100);
        const productsForResponse = allProducts.slice(0, safeLimit);

        if (!parsedVariant && total > 0 && parsedBrand && parsedModel) {
          const uniqueModels = [
            ...new Set(allProducts.map((p: { vehicleModel: string }) => p.vehicleModel))
          ]
            .filter((model) => model && typeof model === 'string' && model.trim().length > 0)
            .sort();

          if (uniqueModels.length > 1) {
            const modelVariantMap = new Map<
              string,
              { variants: Set<string>; hasBaseVariant: boolean }
            >();

            allProducts.forEach((p: { vehicleModel: string; vehicleVariant: string }) => {
              const model = p.vehicleModel;
              const variant = p.vehicleVariant && p.vehicleVariant.trim() ? p.vehicleVariant : null;

              if (!modelVariantMap.has(model)) {
                modelVariantMap.set(model, { variants: new Set(), hasBaseVariant: false });
              }

              const modelData = modelVariantMap.get(model)!;
              if (variant) {
                modelData.variants.add(variant);
              } else {
                modelData.hasBaseVariant = true;
              }
            });

            const modelList = Array.from(modelVariantMap.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([model, modelData]) => {
                const variantList: string[] = [];
                if (modelData.hasBaseVariant) {
                  variantList.push('base variant');
                }
                variantList.push(...Array.from(modelData.variants));

                const variantText = variantList.length > 0 ? ` (${variantList.join(', ')})` : '';
                return ` ${model}${variantText}`;
              })
              .join('\n');

            return structuredResponse(
              `I found ${name} for these ${parsedBrand} models:\n${modelList}\n\nWhich model and variant is your vehicle?`,
              { total, products: productsForResponse, availableModels: uniqueModels, needsModelSelection: true, brand: parsedBrand }
            );
          }

          if (uniqueModels.length === 1) {
            const variantList: string[] = [];
            const hasBaseVariant = allProducts.some(
              (p: { vehicleVariant: string }) => !p.vehicleVariant || !p.vehicleVariant.trim()
            );
            const uniqueVariants = (
              [...new Set(allProducts.map((p: { vehicleVariant: string }) => p.vehicleVariant))] as string[]
            )
              .filter((variant) => variant && typeof variant === 'string' && variant.trim())
              .sort();

            if (hasBaseVariant) {
              variantList.push('base variant');
            }
            variantList.push(...uniqueVariants);

            if (variantList.length > 1) {
              const variantDisplay = variantList.map((variant) => ` ${variant}`).join('\n');

              return structuredResponse(
                `I found ${name} for these ${parsedBrand} ${parsedModel} variants:\n${variantDisplay}\n\nCan you specify which variant your vehicle is?`,
                { total, products: productsForResponse, availableVariants: variantList, needsVariantSelection: true, brand: parsedBrand, model: parsedModel }
              );
            }
          }
        }

        if (total > 1) {
          const productGroups = new Map<string, string[]>();

          productsForResponse.forEach((p) => {
            const cleanName = p.name.replace(/^JAEGER automotive\s*/i, '').trim();
            const vehicleInfo = `${p.vehicleBrand} ${p.vehicleModel} ${p.vehicleVariant}`.trim();
            const displayKey = `${cleanName} for ${vehicleInfo}`;

            if (!productGroups.has(displayKey)) {
              productGroups.set(displayKey, []);
            }
            productGroups.get(displayKey)!.push(p.productNumber);
          });

          const variantLines = Array.from(productGroups.entries())
            .map(([displayName, productNumbers]) => {
              const numbersList = productNumbers.join(', ');
              return ` ${displayName} (${numbersList})`;
            })
            .join('\n');

          return structuredResponse(
            `Found ${total} items for '${name}':\n${variantLines}`,
            { total, products: productsForResponse, searchTerm: name }
          );
        }

        if (total === 1) {
          const p = allProducts[0];
          const cleanName = p.name.replace(/^JAEGER automotive\s*/i, '').trim();
          const vehicleInfo = `${p.vehicleBrand} ${p.vehicleModel} ${p.vehicleVariant}`.trim();
          return structuredResponse(
            `Found one product: ${cleanName} for ${vehicleInfo} (${p.productNumber})`,
            { total: 1, products: [p], searchTerm: name }
          );
        }

        // No matches
        return structuredResponse(
          `No products found for "${name}".`,
          { total: 0, products: [], searchTerm: name }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'search-product-catalog');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Product search failed: ${sanitized.message}`, 'catalog_search_error');
      }
    }
  );

  // -------------------- Customer search tool --------------------
  const customerAddressShape = z.object({
    street: z.string().nullable(),
    zipcode: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
    phoneNumber: z.string().nullable()
  }).nullable();

  const customerInputShape = {
    email: z.string().email().optional(),
    customerNumber: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    phone: z.string().min(1).optional()
  } as const;

  const customerOutputShape = {
    total: z.number(),
    customers: z.array(
      z.object({
        id: z.string(),
        customerNumber: z.string().nullable(),
        email: z.string(),
        firstName: z.string().nullable(),
        lastName: z.string().nullable(),
        title: z.string().nullable(),
        active: z.boolean(),
        defaultBillingAddress: customerAddressShape,
        defaultShippingAddress: customerAddressShape
      })
    )
  } as const;

  serverInstance.registerTool(
    'search-customer',
    {
      title: 'Search customers',
      description: 'Find customers by email, customer number, name, or phone',
      inputSchema: customerInputShape,
      outputSchema: customerOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({
      email,
      customerNumber,
      firstName,
      lastName,
      phone
    }: {
      email?: string;
      customerNumber?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    }) => {
      try {
        const filters: Array<Record<string, unknown>> = [];

        if (email) {
          filters.push({ type: 'equals', field: 'email', value: email });
        }
        if (customerNumber) {
          filters.push({ type: 'equals', field: 'customerNumber', value: customerNumber });
        }
        if (firstName) {
          filters.push({ type: 'contains', field: 'firstName', value: firstName });
        }
        if (lastName) {
          filters.push({ type: 'contains', field: 'lastName', value: lastName });
        }
        if (phone) {
          filters.push({
            type: 'multi',
            operator: 'OR',
            queries: [
              { type: 'contains', field: 'defaultBillingAddress.phoneNumber', value: phone },
              { type: 'contains', field: 'defaultShippingAddress.phoneNumber', value: phone }
            ]
          });
        }

        if (filters.length === 0) {
          return structuredResponse(
            'Please provide at least one search criterion (email, customer number, name, or phone).',
            { total: 0, customers: [], validationError: 'No search criteria provided' }
          );
        }

        const criteria = {
          filter: filters.length === 1 ? filters : [{ type: 'multi', operator: 'AND', queries: filters }],
          associations: {
            defaultBillingAddress: {
              associations: { country: {} }
            },
            defaultShippingAddress: {
              associations: { country: {} }
            }
          },
          limit: config.MCP_CUSTOMER_SEARCH_LIMIT
        } as const;

        const result = await fastifyInstance.shopware.searchCustomers(criteria);
        const cleaned = stripExtensionsDeep(result);

        const customers = ((cleaned.data || []) as Array<Record<string, unknown>>).map((c) => {
          const billingAddr = c.defaultBillingAddress as Record<string, unknown> | null;
          const shippingAddr = c.defaultShippingAddress as Record<string, unknown> | null;
          const billingCountry = billingAddr?.country as Record<string, unknown> | undefined;
          const shippingCountry = shippingAddr?.country as Record<string, unknown> | undefined;

          return {
            id: c.id as string,
            customerNumber: (c.customerNumber as string) ?? null,
            email: c.email as string,
            firstName: (c.firstName as string) ?? null,
            lastName: (c.lastName as string) ?? null,
            title: (c.title as string) ?? null,
            active: (c.active as boolean) ?? true,
            defaultBillingAddress: billingAddr
              ? {
                  street: (billingAddr.street as string) ?? null,
                  zipcode: (billingAddr.zipcode as string) ?? null,
                  city: (billingAddr.city as string) ?? null,
                  country: (billingCountry?.name as string) ?? null,
                  phoneNumber: (billingAddr.phoneNumber as string) ?? null
                }
              : null,
            defaultShippingAddress: shippingAddr
              ? {
                  street: (shippingAddr.street as string) ?? null,
                  zipcode: (shippingAddr.zipcode as string) ?? null,
                  city: (shippingAddr.city as string) ?? null,
                  country: (shippingCountry?.name as string) ?? null,
                  phoneNumber: (shippingAddr.phoneNumber as string) ?? null
                }
              : null
          };
        });

        const total = cleaned.total ?? customers.length;

        if (total === 0) {
          return structuredResponse(
            'No customers found matching the search criteria.',
            { total: 0, customers: [] }
          );
        }

        if (total === 1) {
          const c = customers[0];
          const fullName = [c.title, c.firstName, c.lastName].filter(Boolean).join(' ');
          const billingAddr = c.defaultBillingAddress;
          const shippingAddr = c.defaultShippingAddress;

          let addressInfo = '';
          if (billingAddr) {
            addressInfo += `\nBilling: ${billingAddr.street}, ${billingAddr.zipcode} ${billingAddr.city}, ${billingAddr.country}`;
            if (billingAddr.phoneNumber) {
              addressInfo += `\nPhone: ${billingAddr.phoneNumber}`;
            }
          }
          if (shippingAddr && JSON.stringify(shippingAddr) !== JSON.stringify(billingAddr)) {
            addressInfo += `\nShipping: ${shippingAddr.street}, ${shippingAddr.zipcode} ${shippingAddr.city}, ${shippingAddr.country}`;
          }

          return structuredResponse(
            `**Customer Found:**\n${fullName}\nEmail: ${c.email}\nCustomer #: ${c.customerNumber ?? 'n/a'}${addressInfo}`,
            { total: 1, customers: [c] }
          );
        }

        // Multiple customers found
        const displayCustomers = customers.slice(0, config.MCP_ORDER_DISPLAY_LIMIT);
        const customerList = displayCustomers
          .map((c) => {
            const fullName = [c.title, c.firstName, c.lastName].filter(Boolean).join(' ');
            return `${fullName} (${c.email}) - Customer #${c.customerNumber ?? 'n/a'}`;
          })
          .join('\n');

        return structuredResponse(
          `Found ${total} customer(s):\n${customerList}${total > config.MCP_ORDER_DISPLAY_LIMIT ? '\n...and more' : ''}\n\nProvide more specific criteria to narrow down the results.`,
          { total, customers: displayCustomers }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'search-customer');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Customer search failed: ${sanitized.message}`, 'customer_search_error');
      }
    }
  );

  // -------------------- Customer orders tool --------------------
  const customerOrdersInputShape = {
    customerId: z.string().optional(),
    email: z.string().email().optional(),
    limit: z.number().min(1).max(100).optional()
  } as const;

  serverInstance.registerTool(
    'get-customer-orders',
    {
      title: 'Get customer orders',
      description: 'Get all orders for a specific customer by ID or email',
      inputSchema: customerOrdersInputShape,
      outputSchema: orderOutputShape,
      annotations: { readOnlyHint: true }
    },
    async ({
      customerId,
      email,
      limit
    }: {
      customerId?: string;
      email?: string;
      limit?: number;
    }) => {
      try {
        if (!customerId && !email) {
          return structuredResponse(
            'Please provide either a customer ID or email address.',
            { total: 0, orders: [], validationError: 'No customer ID or email provided' }
          );
        }

        let searchCustomerId = customerId;

        // If email provided but no customer ID, look up customer first
        if (email && !customerId) {
          const customerResult = await fastifyInstance.shopware.searchCustomersByEmail(email, false);
          const cleanedCustomers = stripExtensionsDeep(customerResult);

          if (cleanedCustomers.total === 0) {
            return structuredResponse(
              `No customer found with email address: ${email}`,
              { total: 0, orders: [], customerNotFound: true, searchedEmail: email }
            );
          }

          const firstCustomer = first(cleanedCustomers.data as unknown[]) as
            | Record<string, unknown>
            | undefined;
          if (!firstCustomer) {
            return structuredResponse(
              `No customer found with email address: ${email}`,
              { total: 0, orders: [], customerNotFound: true, searchedEmail: email }
            );
          }
          searchCustomerId = firstCustomer.id as string;
        }

        // Search orders for the customer (with limits to prevent huge payloads)
        const criteria = {
          filter: [{ type: 'equals', field: 'orderCustomer.customerId', value: searchCustomerId }],
          limit: limit || config.MCP_ORDER_DISPLAY_LIMIT,
          sort: [{ field: 'orderDateTime', order: 'DESC' }],
          associations: {
            stateMachineState: {},
            transactions: {
              limit: 10,
              associations: {
                stateMachineState: {},
                paymentMethod: {}
              }
            },
            deliveries: {
              limit: 20,
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
              limit: 100,
              associations: { product: {} }
            }
          }
        } as const;

        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);
        const essentials = {
          total: cleaned.total,
          orders: ((cleaned.data as unknown[]) || []).map((o) =>
            mapOrderEssentials(o as Parameters<typeof mapOrderEssentials>[0])
          )
        } as const;

        if (essentials.total === 0) {
          return structuredResponse(
            `No orders found for this customer.`,
            { total: 0, orders: [], customerId: searchCustomerId }
          );
        }

        // Show customer's order history
        const firstOrder = first(essentials.orders);
        const customerName =
          firstOrder?.customer?.firstName && firstOrder?.customer?.lastName
            ? `${firstOrder.customer.firstName} ${firstOrder.customer.lastName}`
            : firstOrder?.customer?.email || 'Customer';

        const orderList = essentials.orders
          .map(
            (o) =>
              `Order #${o.customer.orderNumber} - ${o.customer.orderDateTime} - €${o.totals.amountTotal} - ${o.status.overall}`
          )
          .join('\n');

        return structuredResponse(
          `**${customerName}'s Orders (${essentials.total} total):**\n${orderList}\n\nUse search-orders with a specific order number for detailed information.`,
          { total: essentials.total, orders: essentials.orders, customerId: searchCustomerId, customerName }
        );
      } catch (err: unknown) {
        logErrorDetails(fastifyInstance.log, err, 'get-customer-orders');
        const sanitized = sanitizeErrorForClient(err);
        return errorResponse(`Customer orders retrieval failed: ${sanitized.message}`, 'customer_orders_error');
      }
    }
  );
};

// MCP endpoint using singleton pattern - create server once, reuse across requests
const registerMcp: FastifyPluginAsync = fp(async (fastify) => {
  // Create single McpServer instance at plugin initialization
  const mcpServer = new McpServer({ name: 'shopware-mcp', version: '0.1.0' });

  // Register all tools once
  registerTools(fastify, mcpServer);

  fastify.post('/mcp', async (request, reply) => {
    reply.hijack();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    reply.raw.on('close', async () => {
      try {
        await transport.close();
      } catch (closeError) {
        fastify.log.warn({ error: closeError }, 'Error closing MCP transport');
      }
      // Note: Do NOT close mcpServer here - it's shared across requests
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body as Record<string, unknown>);
    } catch (error) {
      fastify.log.error({ error }, 'MCP endpoint error');

      if (!reply.raw.headersSent) {
        try {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null
          }));
        } catch (writeError) {
          fastify.log.error({ error: writeError }, 'Failed to send error response');
        }
      }
    }
  });

  const methodNotAllowed = (reply: { code: (n: number) => { send: (body: unknown) => void } }) => {
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
  };

  fastify.get('/mcp', (_, reply) => methodNotAllowed(reply));
  fastify.delete('/mcp', (_, reply) => methodNotAllowed(reply));

  fastify.log.info('Stateless MCP endpoint ready at /mcp (singleton pattern)');
});

export { registerMcp };
