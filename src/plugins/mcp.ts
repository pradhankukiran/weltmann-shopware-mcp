import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Product } from './csv';

// Reuse simple HTML stripping logic from routes
const stripHtml = (html: string | null | undefined) => {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\r?\n|\r/g, ' ').replace(/\s{2,}/g, ' ').trim();
};

// Helper to attach tools to a given server instance
const registerTools = (fastifyInstance: any, serverInstance: McpServer) => {
  // Helper that clones content blocks and appends a JSON representation of the structured data
  // Voice agents stumble over raw JSON in the spoken response, so keep
  // the structured payload purely in `structuredContent` and return the
  // original text blocks untouched.
  const withStructuredJson = (_structured: any, contentBlocks: any[]) => contentBlocks;

  const inputShape = {
    productNumber: z.string()
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
  /**
   * Tool: search-orders
   * ---------------------
   * Find one or many orders. If an `orderNumber` is provided the tool will attempt to
   * return that single order (and a helpful human-readable summary). Otherwise it
   * supports pagination via `page` & `limit` parameters to list the most recent
   * orders.
   *
   * Input  – `orderInputShape` (zod)
   *   orderNumber?: string  – exact Shopware order number to look up
   *   page?:        number  – pagination (defaults to 1)
   *   limit?:       number  – max items per page (1-250, defaults to 10)
   *
   * Output – `orderOutputShape` (zod)
   *   total:  number – total number of matching orders
   *   orders: Order[] – mapped essentials (customer, status, items, …)
   */
  const orderInputShape = {
    orderNumber: z.string().optional(),
    page: z.number().min(1).optional(),
    limit: z.number().min(1).max(250).optional()
  } as const;

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
          address: z.any().nullable(),
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


  const stripExtensionsDeep = (input: any): any => {
    if (Array.isArray(input)) {
      return input.map(item => stripExtensionsDeep(item));
    }

    if (input && typeof input === 'object') {
      const { extensions, _uniqueIdentifier, versionId, translated, ...rest } = input as Record<string, any>;
      for (const key of Object.keys(rest)) {
        rest[key] = stripExtensionsDeep(rest[key]);
      }
      return rest;
    }

    return input;
  };

  const mapEssentials = (order: any) => {
    const firstDelivery = order.deliveries?.[0] ?? {};
    const firstTransaction = order.transactions?.[0] ?? {};

    return {
      customer: {
        orderNumber: order.orderNumber,
        orderDateTime: order.orderDateTime,
        firstName: order.orderCustomer?.firstName ?? null,
        lastName: order.orderCustomer?.lastName ?? null,
        email: order.orderCustomer?.email ?? null,
        customerNumber: order.orderCustomer?.customerNumber ?? null,
        salesChannel: order.salesChannel?.name ?? null
      },
      status: {
        overall: order.stateMachineState?.name ?? null,
        payment: firstTransaction.stateMachineState?.name ?? null,
        shipping: firstDelivery.stateMachineState?.name ?? null
      },
      shipping: {
        address: firstDelivery.shippingOrderAddress
          ? {
              street: firstDelivery.shippingOrderAddress.street,
              zipcode: firstDelivery.shippingOrderAddress.zipcode,
              city: firstDelivery.shippingOrderAddress.city,
              company: firstDelivery.shippingOrderAddress.company,
              phoneNumber: firstDelivery.shippingOrderAddress.phoneNumber,
              country: firstDelivery.shippingOrderAddress.country?.name ?? null
            }
          : null,
        trackingCodes: firstDelivery.trackingCodes ?? [],
        shippingMethod: {
          name: firstDelivery.shippingMethod?.name ?? null,
          description: firstDelivery.shippingMethod?.description ?? null
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
        amountTotal: order.amountTotal ?? null,
        shippingTotal: order.shippingTotal ?? null,
        paymentMethod: firstTransaction.paymentMethod?.name ?? null
      }
    } as const;
  };

  serverInstance.registerTool(
    'search-orders',
    {
      title: 'Search orders',
      description: 'Find orders by number or list recent ones',
      inputSchema: orderInputShape,
      outputSchema: orderOutputShape
    },
    async ({ orderNumber, page, limit }: any) => {
      const criteria: any = orderNumber
        ? {
            filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }]
          }
        : {
            page: page || 1,
            limit: limit || 10
          };

      // Always include associations for essentials
      criteria.associations = {
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

      const result = await fastifyInstance.shopware.searchOrders(criteria);

      const cleaned = stripExtensionsDeep(result);
      const essentials = {
        total: cleaned.total,
        orders: (cleaned.data || []).map(mapEssentials)
      } as const;

      // Handle no match
      if (orderNumber && essentials.total === 0) {
        return {
          structuredContent: essentials,
          content: withStructuredJson(essentials, [
            { type: 'text', text: `No order found for number ${orderNumber}.` }
          ])
        } as any;
      }

      // If a specific order requested and found, provide shipping status summary
      if (orderNumber && essentials.total === 1) {
        const ord = essentials.orders[0];
        const addr = ord.shipping.address;
        const addressLine = addr
          ? `${addr.street}, ${addr.zipcode} ${addr.city}, ${addr.country ?? ''}`.trim()
          : 'n/a';
        const trackingTxt = ord.shipping.trackingCodes && ord.shipping.trackingCodes.length > 0
          ? ord.shipping.trackingCodes.join(', ')
          : 'not yet assigned';

        // Build an item overview so the client sees the ordered products as well.
        const displayItems = ord.items.slice(0, 10);
        const itemLines = displayItems
          .map((it: any) => `${it.quantity} × ${it.name} (PN: ${it.productNumber ?? 'n/a'}) – ${it.totalPrice}`)
          .join('\n');

        return {
          structuredContent: essentials,
          content: withStructuredJson(essentials, [
            {
              type: 'text',
              text: `Order #${orderNumber} shipping status: ${ord.status.shipping ?? 'n/a'}\n` +
                `Shipping method: ${ord.shipping.shippingMethod.name ?? 'n/a'} – ${ord.shipping.shippingMethod.description ?? ''}\n` +
                `Address: ${addressLine}\n` +
                `Tracking: ${trackingTxt}\n` +
                `Items:\n${itemLines}${ord.items.length > displayItems.length ? '\n…and more' : ''}`
            }
          ])
        } as any;
      }

      // Generic list response
      const displayOrders = essentials.orders.slice(0, 10);
      const listLines = displayOrders
        .map((o: any) => `#${o.customer.orderNumber} – ${o.customer.orderDateTime}`)
        .join('\n');

      const listStructured = { total: essentials.total, orders: displayOrders } as const;

      return {
        structuredContent: listStructured,
        content: withStructuredJson(listStructured, [
          {
            type: 'text',
            text: `Found ${essentials.total} order(s).\n${listLines}${
              essentials.total > displayOrders.length ? '\n…and more' : ''
            }\nProvide an orderNumber to get a specific order.`
          }
        ])
      } as any;
    }
  );

  // -------------------- Product search tool (by product number) --------------------
  /**
   * Tool: search-product-number
   * ---------------------------
   * Fetch product information by its unique product number (SKU).
   *
   * Input  – `{ productNumber: string }`
   * Output – `outputShape` (zod)
   *
   * Behaviour:
   *   When no match is found, return a helpful text & an empty list.
   *   When exactly one product is found, return a concise summary including
   *     available stock & a short description.
   *   When multiple products match (e.g. number is not unique across variants)
   *     return a shortlist and prompt the user for clarification.
   */
  serverInstance.registerTool(
    'search-product-number',
    {
      title: 'Search product by number',
      description: 'Search for a product by its product number',
      inputSchema: inputShape,
      outputSchema: outputShape
    },
    async ({ productNumber }: any) => {
      const result = await fastifyInstance.shopware.searchProductsByNumber(productNumber, true);

      const products = (result?.data || []).map((p: any) => ({
        name: p.translated?.name ?? p.name ?? '',
        productNumber: p.productNumber,
        description: stripHtml(p.translated?.description ?? p.description),
        availableStock: p.availableStock ?? p.stock ?? null
      }));

      const total = result.total ?? products.length;

      if (total > 1) {
        // Keep the textual and structured representations in sync by showing
        // the same subset of products in both places.
        const displayProducts = products.slice(0, 10);
        const shortlist = displayProducts
          .map((p: any, idx: number) => `${idx + 1}. ${p.name}`)
          .join('\n');

        const listStructured = {
          total,
          products: displayProducts.map((p: any) => ({
            name: p.name,
            productNumber: p.productNumber,
            availableStock: p.availableStock ?? null
          }))
        } as const;

        return {
          structuredContent: listStructured,
          content: [
            {
              type: 'text',
              text: `I found ${total} matching products. Which one are you interested in? Please reply with the list number (1-${displayProducts.length}) or the product name, and I can show exact details.\n${shortlist}${
                total > displayProducts.length ? '\n…and more' : ''
              }`
            }
          ]
        } as any;
      }

      if (total === 0) {
        const emptyStructured = { total, products } as const;
        return {
          structuredContent: emptyStructured,
          content: withStructuredJson(emptyStructured, [
            { type: 'text', text: `Couldn't find any item for "${productNumber}". Could you check the product number for any missing underscores, hyphens or dots?` }
          ])
        } as any;
      }

      const allStructured = { total, products } as const;

      // For a single, exact match, show a detailed summary.
      if (total === 1) {
        const p = products[0];

        let description = p.description || '';
        if (description.length > 250) {
          description = `${description.substring(0, 250)}…`;
        }

        const descriptionTxt = description ? `\n\n${description}` : '';

        return {
          structuredContent: allStructured,
          content: [
            {
              type: 'text',
              text: `**${p.name}**${descriptionTxt}`.trim() // stock info removed from content
            }
          ]
        } as any;
      }

      // For multiple matches (e.g. from a non-unique product number search),
      // just list them.
      const detailLines = products.map((p: any) => `${p.name}`);

      return {
        structuredContent: allStructured,
        content: [
          {
            type: 'text',
            text: `Found ${total} product(s):\n${detailLines.join('\n')}`
          }
        ]
      } as any;
    }
  );

  // -------------------- Stock level tool --------------------
  /**
   * Tool: get-stock-level
   * ----------------------
   * Retrieve the available stock quantity for a given product number (SKU).
   *
   * Input  – `{ productNumber: string }`
   * Output – {
   *   productNumber: string,
   *   availableStock: number | null
   * }
   */
  serverInstance.registerTool(
    'get-stock-level',
    {
      title: 'Get stock level',
      description: 'Return the available stock for a product identified by its product number',
      inputSchema: {
        productNumber: z.string().describe('The product number (SKU) to check')
      },
      outputSchema: {
        productNumber: z.string(),
        availableStock: z.number().nullable()
      }
    },
    async ({ productNumber }: any) => {
      const result = await fastifyInstance.shopware.searchProductsByNumber(productNumber, true);

      if (!result || (result.total ?? 0) === 0) {
        const emptyPayload = { productNumber, availableStock: null } as const;
        return {
          structuredContent: emptyPayload,
          content: withStructuredJson(emptyPayload, [
            { type: "text", text: `Product with number "${productNumber}" not found.` }
          ])
        } as any;
      }
      // Use the first matching product (most searches will be unique)
      const product = result.data[0] as any;
      const availableStock: number | null = product.availableStock ?? product.stock ?? null;

      const payload = {
        productNumber,
        availableStock
      } as const;

      const stockTxt = availableStock != null ? `${availableStock}` : 'n/a';

      return {
        structuredContent: payload,
        content: [
          {
            type: 'text',
            text: `${stockTxt} units are available.`.trim()
          }
        ]
      } as any;
    }
  );

  serverInstance.registerTool(
    'check-order-status',
    {
      title: 'Check order status',
      description: 'Return a customer-friendly order status and delivery estimate for a given order number',
      inputSchema: {
        orderNumber: z.string().describe('The order number to check')
      },
      outputSchema: {
        orderNumber: z.string(),
        statusText: z.string(),
        deliveryEstimate: z.string().nullable()
      }
    },
    async ({ orderNumber }: any) => {
      // Build minimal criteria: we only need delivery + state associations
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

      // Early exit if no order found
      if (cleaned.total === 0) {
        const payload = {
          orderNumber,
          statusText: `Order #${orderNumber} not found.`,
          deliveryEstimate: null
        } as const;
        return {
          structuredContent: payload,
          content: withStructuredJson(payload, [
            { type: "text", text: `Order #${orderNumber} not found.` }
          ])
        } as any;
      }
      const essential = mapEssentials(cleaned.data[0]);

      // Helper: convert internal status to a customer-friendly sentence
      const getCustomerFriendlyStatus = (status: any) => {
        const shippingRaw = (status.shipping ?? status.overall ?? 'unknown').toString();
        const shipping = shippingRaw.toLowerCase();
        switch (shipping) {
          case 'open':
          case 'in progress':
            return 'Your order has been received and is currently being processed.';
          case 'partially shipped':
          case 'shipped':
          case 'completed':
          case 'teilversandt': // German: partially shipped
          case 'versandt':     // German: shipped
          case 'abgeschlossen': // German: completed
            return 'Good news! Your order has already been shipped.';
          case 'cancelled':
          case 'storniert': // German
            return 'Unfortunately, this order has been cancelled.';
          case 'returned':
          case 'retour':
            return 'This order was returned to us.';
          default:
            return `Current status: ${shippingRaw}`;
        }
      };

      // Helper: naive delivery ETA calculation (can be improved once more data is available)
      const calculateDeliveryEstimate = (_order: any): string | null => {
        const shippingState = (_order.status.shipping ?? _order.status.overall ?? '').toString().toLowerCase();
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

      const payload = {
        orderNumber,
        statusText,
        deliveryEstimate
      } as const;

      return {
        structuredContent: payload,
        content: [
          {
            type: 'text',
            text: `**Order #${orderNumber}**\n${statusText}${deliveryEstimate ? `\nEstimated delivery: ${deliveryEstimate}` : ''}`
          }
        ]
      } as any;
    }
  );

  // -------------------- Payment status tool --------------------
  /**
   * Tool: check-payment-status
   * --------------------------
   * Retrieve a customer-friendly payment status text for an order.
   *
   * Input  – `{ orderNumber: string }`
   * Output – {
   *   orderNumber: string,
   *   paymentStatusText: string,
   *   paymentMethod: string | null
   * }
   */
  serverInstance.registerTool(
    'check-payment-status',
    {
      title: 'Check payment status',
      description: 'Return a customer-friendly payment status for a given order number',
      inputSchema: {
        orderNumber: z.string().describe('The order number to check')
      },
      outputSchema: {
        orderNumber: z.string(),
        paymentStatusText: z.string(),
        paymentMethod: z.string().nullable()
      }
    },
    async ({ orderNumber }: any) => {
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
        const payload = {
          orderNumber,
          paymentStatusText: `Order #${orderNumber} not found.`,
          paymentMethod: null
        } as const;
        return {
          structuredContent: payload,
          content: withStructuredJson(payload, [
            { type: "text", text: `Order #${orderNumber} not found.` }
          ])
        } as any;
      }
      const order = cleaned.data[0] as any;
      const firstTx = order.transactions?.[0] ?? {};
      const paymentStateRaw = firstTx.stateMachineState?.name ?? 'unknown';
      const paymentState = paymentStateRaw.toString().toLowerCase();

      const paymentMethodName: string | null = firstTx.paymentMethod?.name ?? null;

      const getFriendlyPaymentStatus = (state: string) => {
        switch (state) {
          case 'open':
          case 'in_progress':
          case 'in progress':
          case 'pending':
          case 'offen': // German
            return 'Payment is still pending.';
          case 'paid':
          case 'completed':
          case 'bezahlt': // German
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

      const payload = {
        orderNumber,
        paymentStatusText,
        paymentMethod: paymentMethodName
      } as const;

      const methodLine = paymentMethodName ? `Payment method: ${paymentMethodName}\n` : '';

      return {
        structuredContent: payload,
        content: [
          {
            type: 'text',
            text: `**Order #${orderNumber}**\n${paymentStatusText}\n${methodLine}`.trimEnd()
          }
        ]
      } as any;
    }
  );

  // -------------------- Order items tool --------------------
  /**
   * Tool: get-order-items
   * ---------------------
   * Simple helper that returns the line items of a given order (name, SKU,
   * quantity, total price). Useful for follow-up questions after an order search.
   */
  serverInstance.registerTool(
    'get-order-items',
    {
      title: 'Get order items',
      description: 'Return the list of items (name, SKU, quantity, price) for a given order number',
      inputSchema: {
        orderNumber: z.string().describe('The order number to retrieve items for')
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
      }
    },
    async ({ orderNumber }: any) => {
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
        const emptyPayload = { orderNumber, items: [] } as const;
        return {
          structuredContent: emptyPayload,
          content: withStructuredJson(emptyPayload, [
            { type: 'text', text: `Order #${orderNumber} not found.` }
          ])
        } as any;
      }

      const orderData = cleaned.data[0] as any;
      const items = (orderData.lineItems || []).map((li: any) => ({
        name: li.product?.translated?.name ?? li.product?.name ?? li.label ?? null,
        productNumber: li.product?.productNumber ?? li.payload?.productNumber ?? null,
        quantity: li.quantity,
        totalPrice: li.totalPrice
      }));

      const payload = { orderNumber, items } as const;

      const itemsLines = items
        .map((it: any) => `${it.quantity} × ${it.name ?? 'n/a'} – ${it.totalPrice}`)
        .join('\n');

      return {
        structuredContent: payload,
        content: withStructuredJson(payload, [
          {
            type: 'text',
            text: `Items for order #${orderNumber}:\n${itemsLines}`
          }
        ])
      } as any;
    }
  );

  // -------------------- Product name search tool --------------------
  serverInstance.registerTool(
    'search-product-catalog',
    {
      title: 'Search product by name',
      description: 'Search over product names from CSV catalog. Accepts either structured vehicle parameters or a single vehicleText to parse automatically.',
      inputSchema: {
        name: z.string().describe('Partial or full product name'),
        limit: z.number().min(1).max(100).optional().describe('Maximum results to return'),
        vehicleBrand: z.string().optional().describe('Vehicle brand to filter results'),
        vehicleModel: z.string().optional().describe('Vehicle model to filter results'),
        vehicleVariant: z.string().optional().describe('Vehicle variant to filter results'),
        vehicleText: z.string().optional().describe('Full vehicle description (e.g., "citroen c5 limousine") - will be parsed automatically')
      },
      outputSchema: {
        total:    z.number(),
        products: z.array(
          z.object({
            productNumber:   z.string(),
            name:            z.string(),
            vehicleBrand:    z.string(),
            vehicleModel:    z.string(),
            vehicleVariant:  z.string()
          })
        ).describe('List of matching products with vehicle details')
      }
    },
    async ({ name, limit, vehicleBrand, vehicleModel, vehicleVariant, vehicleText }: any) => {
      try {
        // Parse vehicle information from vehicleText if provided
        let parsedBrand = vehicleBrand;
        let parsedModel = vehicleModel;
        let parsedVariant = vehicleVariant;

        if (vehicleText) {
          const vehicleParts = vehicleText.trim().split(/\s+/);
          if (vehicleParts.length >= 2) {
            parsedBrand = parsedBrand || vehicleParts[0];
            parsedModel = parsedModel || vehicleParts[1];
            // Use remaining parts as variant if not explicitly provided
            if (!parsedVariant && vehicleParts.length > 2) {
              parsedVariant = vehicleParts.slice(2).join(' ');
            }
          }
        }

        parsedBrand = parsedBrand?.trim();
        parsedModel = parsedModel?.trim();
        parsedVariant = parsedVariant?.trim();

        // Helper function to normalize text (remove accents and convert to lowercase)
        const normalizeText = (text: string | null | undefined) =>
          (text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

        // Get all products from CSV
        const allProductsCSV = fastifyInstance.products;

        // Filter products by name
        const searchWords = name.toLowerCase().split(/\s+/).filter((word: string) => word.length > 1);
        let hits = allProductsCSV.filter((p: Product) => {
          const productNameLower = normalizeText(p.productName);
          // Product must contain ALL words from the search query
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
            const normalizedVariantTerms = baseVariantTerms.map(term => normalizeText(term));
            const isBaseVariantRequest = normalizedVariantTerms.some(term =>
              normalizedVariant.includes(term)
            );

            if (isBaseVariantRequest) {
              // Filter for products with empty/null variants (base variant)
              hits = hits.filter((p: Product) => !p.vehicleVariant || !p.vehicleVariant.trim());
            } else {
              // Use normal variant filtering
              hits = hits.filter((p: Product) =>
                normalizeText(p.vehicleVariant).includes(normalizedVariant)
              );
            }
          }
        }

        const allProducts = hits.map((p: Product) => ({
          productNumber:  p.productNumber,
          name:           p.productName,
          vehicleBrand:   p.vehicleBrand ?? '',
          vehicleModel:   p.vehicleModel ?? '',
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
        const structured = { total, products: productsForResponse };

        if (!parsedVariant && total > 0 && parsedBrand && parsedModel) {
          // First check if we have multiple vehicle models
          const uniqueModels = [...new Set(allProducts.map((p: any) => p.vehicleModel))]
            .filter(model => model && typeof model === 'string' && model.trim().length > 0)
            .sort(); // Sort alphabetically for better UX

          if (uniqueModels.length > 1) {
            // Multiple models found - show models with their variants
            const modelVariantMap = new Map<string, { variants: Set<string>, hasBaseVariant: boolean }>();

            allProducts.forEach((p: any) => {
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

            return {
              structuredContent: {
                total: 0, // No actual products, just model selection
                products: [] // Empty array to satisfy schema
              },
              content: [
                {
                  type: 'text',
                  text: `I found ${name} for these ${parsedBrand} models:\n${modelList}\n\nWhich model and variant is your vehicle?`
                },
              ],
            } as any;
          }

          if (uniqueModels.length === 1) {
            // Single model - check for variants
            const variantList: string[] = [];
            const hasBaseVariant = allProducts.some((p: any) => !p.vehicleVariant || !p.vehicleVariant.trim());
            const uniqueVariants = ([...new Set(allProducts.map((p: any) => p.vehicleVariant))] as string[])
              .filter(variant => variant && typeof variant === 'string' && variant.trim())
              .sort(); // Sort alphabetically for better UX

            if (hasBaseVariant) {
              variantList.push('base variant');
            }
            variantList.push(...uniqueVariants);

            if (variantList.length > 1) {
              const variantDisplay = variantList.map(variant => ` ${variant}`).join('\n');

              return {
                structuredContent: {
                  total: 0, // No actual products, just variant selection
                  products: [] // Empty array to satisfy schema
                },
                content: [
                  {
                    type: 'text',
                    text: `I found ${name} for these ${parsedBrand} ${parsedModel} variants:\n${variantDisplay}\n\nCan you specify which variant your vehicle is?`
                  },
                ],
              } as any;
            }
          }
        }

        if (total > 1) {
          // Group products by identical display name and vehicle info
          const productGroups = new Map<string, string[]>();

          productsForResponse.forEach((p: any) => {
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
          return {
            structuredContent: structured,
            content: [
              {
                type: 'text',
                text: `Found ${total} items for '${name}':\n${variantLines}`
              },
            ],
          } as any;
        }

        if (total === 1) {
          const p = allProducts[0];
          const cleanName = p.name.replace(/^JAEGER automotive\s*/i, '').trim();
          const vehicleInfo = `${p.vehicleBrand} ${p.vehicleModel} ${p.vehicleVariant}`.trim();
          return {
            structuredContent: structured,
            content: [
              {
                type: 'text',
                text: `Found one product: ${cleanName} for ${vehicleInfo} (${p.productNumber})`,
              },
            ],
          } as any;
        }

        // No matches
        return {
          structuredContent: structured,
          content: [
            {
              type: 'text',
              text: `No products found for "${name}".`,
            },
          ],
        } as any;
      } catch (err: any) {
        fastifyInstance.log.error(err);
        const empty = { total: 0, products: [] };
        return {
          structuredContent: empty,
          content: [
            { type: 'text', text: `Product search failed: ${err.message}` },
          ],
        } as any;
      }
    }
  );
  // -------------------- Customer search tool --------------------
  /**
   * Tool: search-customer
   * ---------------------
   * Find customers by various criteria like email, customer number, name, or phone.
   * Returns customer details including contact information and addresses.
   *
   * Input  – `customerInputShape` (zod)
   *   email?:          string  – customer email address
   *   customerNumber?: string  – customer number
   *   firstName?:      string  – first name (partial match)
   *   lastName?:       string  – last name (partial match)
   *   phone?:          string  – phone number
   *
   * Output – `customerOutputShape` (zod)
   *   total:     number     – total number of matching customers
   *   customers: Customer[] – customer details with addresses
   */
  const customerInputShape = {
    email: z.string().optional(),
    customerNumber: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional()
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
        defaultBillingAddress: z.object({
          street: z.string().nullable(),
          zipcode: z.string().nullable(),
          city: z.string().nullable(),
          country: z.string().nullable(),
          phoneNumber: z.string().nullable()
        }).nullable(),
        defaultShippingAddress: z.object({
          street: z.string().nullable(),
          zipcode: z.string().nullable(),
          city: z.string().nullable(),
          country: z.string().nullable(),
          phoneNumber: z.string().nullable()
        }).nullable()
      })
    )
  } as const;

  serverInstance.registerTool(
    'search-customer',
    {
      title: 'Search customers',
      description: 'Find customers by email, customer number, name, or phone',
      inputSchema: customerInputShape,
      outputSchema: customerOutputShape
    },
    async ({ email, customerNumber, firstName, lastName, phone }: any) => {
      // Build search criteria based on provided inputs
      const filters: any[] = [];
      
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
        // Search in both billing and shipping address phone numbers
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
        const emptyStructured = { total: 0, customers: [] } as const;
        return {
          structuredContent: emptyStructured,
          content: withStructuredJson(emptyStructured, [
            { type: 'text', text: 'Please provide at least one search criterion (email, customer number, name, or phone).' }
          ])
        } as any;
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
        limit: 50 // Reasonable limit for customer search
      } as const;

      const result = await fastifyInstance.shopware.searchCustomers(criteria);
      const cleaned = stripExtensionsDeep(result);

      const customers = (cleaned.data || []).map((c: any) => ({
        id: c.id,
        customerNumber: c.customerNumber ?? null,
        email: c.email,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        title: c.title ?? null,
        active: c.active ?? true,
        defaultBillingAddress: c.defaultBillingAddress ? {
          street: c.defaultBillingAddress.street ?? null,
          zipcode: c.defaultBillingAddress.zipcode ?? null,
          city: c.defaultBillingAddress.city ?? null,
          country: c.defaultBillingAddress.country?.name ?? null,
          phoneNumber: c.defaultBillingAddress.phoneNumber ?? null
        } : null,
        defaultShippingAddress: c.defaultShippingAddress ? {
          street: c.defaultShippingAddress.street ?? null,
          zipcode: c.defaultShippingAddress.zipcode ?? null,
          city: c.defaultShippingAddress.city ?? null,
          country: c.defaultShippingAddress.country?.name ?? null,
          phoneNumber: c.defaultShippingAddress.phoneNumber ?? null
        } : null
      }));

      const total = cleaned.total ?? customers.length;
      const structured = { total, customers } as const;

      if (total === 0) {
        return {
          structuredContent: structured,
          content: withStructuredJson(structured, [
            { type: 'text', text: 'No customers found matching the search criteria.' }
          ])
        } as any;
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

        return {
          structuredContent: structured,
          content: withStructuredJson(structured, [
            {
              type: 'text',
              text: `**Customer Found:**\n${fullName}\nEmail: ${c.email}\nCustomer #: ${c.customerNumber ?? 'n/a'}${addressInfo}`
            }
          ])
        } as any;
      }

      // Multiple customers found
      const customerList = customers.slice(0, 10).map((c: any) => {
        const fullName = [c.title, c.firstName, c.lastName].filter(Boolean).join(' ');
        return `${fullName} (${c.email}) - Customer #${c.customerNumber ?? 'n/a'}`;
      }).join('\n');

      const displayStructured = { total, customers: customers.slice(0, 10) } as const;

      return {
        structuredContent: displayStructured,
        content: withStructuredJson(displayStructured, [
          {
            type: 'text',
            text: `Found ${total} customer(s):\n${customerList}${total > 10 ? '\n...and more' : ''}\n\nProvide more specific criteria to narrow down the results.`
          }
        ])
      } as any;
    }
  );

  // -------------------- Customer orders tool --------------------
  /**
   * Tool: get-customer-orders
   * --------------------------
   * Retrieve all orders for a specific customer, either by customer ID or email.
   *
   * Input  – `customerOrdersInputShape` (zod)
   *   customerId?: string – customer ID from search-customer
   *   email?:      string – customer email address
   *   limit?:      number – max orders to return (defaults to 10)
   *
   * Output – Same as search-orders output
   */
  const customerOrdersInputShape = {
    customerId: z.string().optional(),
    email: z.string().optional(),
    limit: z.number().min(1).max(100).optional()
  } as const;

  serverInstance.registerTool(
    'get-customer-orders',
    {
      title: 'Get customer orders',
      description: 'Get all orders for a specific customer by ID or email',
      inputSchema: customerOrdersInputShape,
      outputSchema: orderOutputShape
    },
    async ({ customerId, email, limit }: any) => {
      if (!customerId && !email) {
        const emptyStructured = { total: 0, orders: [] } as const;
        return {
          structuredContent: emptyStructured,
          content: withStructuredJson(emptyStructured, [
            { type: 'text', text: 'Please provide either a customer ID or email address.' }
          ])
        } as any;
      }

      let searchCustomerId = customerId;

      // If email provided but no customer ID, look up customer first
      if (email && !customerId) {
        const customerResult = await fastifyInstance.shopware.searchCustomersByEmail(email, false);
        const cleanedCustomers = stripExtensionsDeep(customerResult);
        
        if (cleanedCustomers.total === 0) {
          const emptyStructured = { total: 0, orders: [] } as const;
          return {
            structuredContent: emptyStructured,
            content: withStructuredJson(emptyStructured, [
              { type: 'text', text: `No customer found with email address: ${email}` }
            ])
          } as any;
        }
        
        searchCustomerId = cleanedCustomers.data[0].id;
      }

      // Search orders for the customer
      const criteria = {
        filter: [{ type: 'equals', field: 'orderCustomer.customerId', value: searchCustomerId }],
        limit: limit || 10,
        sort: [{ field: 'orderDateTime', order: 'DESC' }],
        associations: {
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
        }
      } as const;

      const result = await fastifyInstance.shopware.searchOrders(criteria);
      const cleaned = stripExtensionsDeep(result);
      const essentials = {
        total: cleaned.total,
        orders: (cleaned.data || []).map(mapEssentials)
      } as const;

      if (essentials.total === 0) {
        return {
          structuredContent: essentials,
          content: withStructuredJson(essentials, [
            { type: 'text', text: `No orders found for this customer.` }
          ])
        } as any;
      }

      // Show customer's order history
      const customerName = essentials.orders[0]?.customer?.firstName && essentials.orders[0]?.customer?.lastName
        ? `${essentials.orders[0].customer.firstName} ${essentials.orders[0].customer.lastName}`
        : essentials.orders[0]?.customer?.email || 'Customer';

      const orderList = essentials.orders.map((o: any) => 
        `Order #${o.customer.orderNumber} - ${o.customer.orderDateTime} - €${o.totals.amountTotal} - ${o.status.overall}`
      ).join('\n');

      return {
        structuredContent: essentials,
        content: withStructuredJson(essentials, [
          {
            type: 'text',
            text: `**${customerName}'s Orders (${essentials.total} total):**\n${orderList}\n\nUse search-orders with a specific order number for detailed information.`
          }
        ])
      } as any;
    }
  );

  // (Additional tools can be registered here)
};

// Stateless MCP endpoint using the above tools
const registerMcp: FastifyPluginAsync = fp(async (fastify) => {
  fastify.post('/mcp', async (request, reply) => {
    reply.hijack();
    const mcpServer = new McpServer({ name: 'shopware-mcp', version: '0.1.0' });
    registerTools(fastify, mcpServer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    reply.raw.on('close', async () => {
      await transport.close();
      await mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, (request as any).body);
  });
  const methodNotAllowed = (reply: any) => {
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null
    });
  };
  fastify.get('/mcp', (_, reply) => methodNotAllowed(reply));
  fastify.delete('/mcp', (_, reply) => methodNotAllowed(reply));
  fastify.log.info('Stateless MCP endpoint ready at /mcp');
});

export { registerMcp };


