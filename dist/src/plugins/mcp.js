"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMcp = void 0;
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const zod_1 = require("zod");
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const embed_1 = require("../utils/embed");
// Reuse simple HTML stripping logic from routes
const stripHtml = (html) => {
    if (typeof html !== 'string')
        return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\r?\n|\r/g, ' ').replace(/\s{2,}/g, ' ').trim();
};
// Helper to attach tools to a given server instance
const registerTools = (fastifyInstance, serverInstance) => {
    // Helper that clones content blocks and appends a JSON representation of the structured data
    const withStructuredJson = (structured, contentBlocks) => {
        return [
            ...contentBlocks,
            {
                type: 'text',
                text: `\n\nStructured data (JSON):\n\n${JSON.stringify(structured, null, 2)}`
            }
        ];
    };
    const inputShape = {
        productNumber: zod_1.z.string()
    };
    const outputShape = {
        total: zod_1.z.number(),
        products: zod_1.z.array(zod_1.z.object({
            productNumber: zod_1.z.string(),
            name: zod_1.z.string(),
            description: zod_1.z.string().optional(),
            availableStock: zod_1.z.number().nullable()
        }))
    };
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
     *   • orderNumber?: string  – exact Shopware order number to look up
     *   • page?:        number  – pagination (defaults to 1)
     *   • limit?:       number  – max items per page (1-250, defaults to 10)
     *
     * Output – `orderOutputShape` (zod)
     *   • total:  number – total number of matching orders
     *   • orders: Order[] – mapped essentials (customer, status, items, …)
     */
    const orderInputShape = {
        orderNumber: zod_1.z.string().optional(),
        page: zod_1.z.number().min(1).optional(),
        limit: zod_1.z.number().min(1).max(250).optional()
    };
    const orderOutputShape = {
        total: zod_1.z.number(),
        orders: zod_1.z.array(zod_1.z.object({
            customer: zod_1.z.object({
                orderNumber: zod_1.z.string(),
                orderDateTime: zod_1.z.string(),
                firstName: zod_1.z.string().nullable(),
                lastName: zod_1.z.string().nullable(),
                email: zod_1.z.string().nullable(),
                customerNumber: zod_1.z.string().nullable(),
                salesChannel: zod_1.z.string().nullable()
            }),
            status: zod_1.z.object({
                overall: zod_1.z.string().nullable(),
                payment: zod_1.z.string().nullable(),
                shipping: zod_1.z.string().nullable()
            }),
            shipping: zod_1.z.object({
                address: zod_1.z.any().nullable(),
                trackingCodes: zod_1.z.array(zod_1.z.string()).nullable(),
                shippingMethod: zod_1.z.object({
                    name: zod_1.z.string().nullable(),
                    description: zod_1.z.string().nullable()
                })
            }),
            items: zod_1.z.array(zod_1.z.object({
                name: zod_1.z.string().nullable(),
                description: zod_1.z.string().nullable(),
                productNumber: zod_1.z.string().nullable(),
                quantity: zod_1.z.number(),
                totalPrice: zod_1.z.number()
            })),
            totals: zod_1.z.object({
                amountTotal: zod_1.z.number().nullable(),
                shippingTotal: zod_1.z.number().nullable(),
                paymentMethod: zod_1.z.string().nullable()
            })
        }))
    };
    const stripExtensionsDeep = (input) => {
        if (Array.isArray(input))
            return input.map(stripExtensionsDeep);
        if (input && typeof input === 'object') {
            const { extensions, _uniqueIdentifier, versionId, translated, ...rest } = input;
            for (const k of Object.keys(rest))
                rest[k] = stripExtensionsDeep(rest[k]);
            return rest;
        }
        return input;
    };
    const mapEssentials = (order) => {
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
            items: (order.lineItems || []).map((li) => ({
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
        };
    };
    serverInstance.registerTool('search-orders', {
        title: 'Search orders',
        description: 'Find orders by number or list recent ones',
        inputSchema: orderInputShape,
        outputSchema: orderOutputShape
    }, async ({ orderNumber, page, limit }) => {
        const criteria = orderNumber
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
        };
        // Handle no match
        if (orderNumber && essentials.total === 0) {
            return {
                structuredContent: essentials,
                content: withStructuredJson(essentials, [
                    { type: 'text', text: `No order found for number ${orderNumber}.` }
                ])
            };
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
                .map((it) => `• ${it.quantity} × ${it.name} (PN: ${it.productNumber ?? 'n/a'}) – ${it.totalPrice}`)
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
            };
        }
        // Generic list response
        const displayOrders = essentials.orders.slice(0, 10);
        const listLines = displayOrders
            .map((o) => `• #${o.customer.orderNumber} – ${o.customer.orderDateTime}`)
            .join('\n');
        const listStructured = { total: essentials.total, orders: displayOrders };
        return {
            structuredContent: listStructured,
            content: withStructuredJson(listStructured, [
                {
                    type: 'text',
                    text: `Found ${essentials.total} order(s).\n${listLines}${essentials.total > displayOrders.length ? '\n…and more' : ''}\nProvide an orderNumber to get a specific order.`
                }
            ])
        };
    });
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
     *   • When no match is found, return a helpful text & an empty list.
     *   • When exactly one product is found, return a concise summary including
     *     available stock & a short description.
     *   • When multiple products match (e.g. number is not unique across variants)
     *     return a shortlist and prompt the user for clarification.
     */
    serverInstance.registerTool('search-product-number', {
        title: 'Search product by number',
        description: 'Search for a product by its product number',
        inputSchema: inputShape,
        outputSchema: outputShape
    }, async ({ productNumber }) => {
        const result = await fastifyInstance.shopware.searchProductsByNumber(productNumber, true);
        const products = (result?.data || []).map((p) => ({
            name: p.name,
            productNumber: p.productNumber,
            description: stripHtml(p.description),
            availableStock: p.availableStock ?? p.stock ?? null
        }));
        const total = result.total ?? products.length;
        if (total > 1) {
            // Keep the textual and structured representations in sync by showing
            // the same subset of products in both places.
            const displayProducts = products.slice(0, 10);
            const shortlist = displayProducts
                .map((p, idx) => `• ${idx + 1}. ${p.name}`)
                .join('\n');
            const listStructured = {
                total,
                products: displayProducts.map((p) => ({
                    name: p.name,
                    productNumber: p.productNumber,
                    availableStock: p.availableStock ?? null
                }))
            };
            return {
                structuredContent: listStructured,
                content: [
                    {
                        type: 'text',
                        text: `I found ${total} matching products. Which one are you interested in? Please reply with the list number (1-${displayProducts.length}) or the product name, and I can show exact details.\n${shortlist}${total > displayProducts.length ? '\n…and more' : ''}`
                    }
                ]
            };
        }
        if (total === 0) {
            const emptyStructured = { total, products };
            return {
                structuredContent: emptyStructured,
                content: withStructuredJson(emptyStructured, [
                    { type: 'text', text: `Couldn't find any item for "${productNumber}". Could you check the product number for any missing underscores, hyphens or dots?` }
                ])
            };
        }
        const allStructured = { total, products };
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
            };
        }
        // For multiple matches (e.g. from a non-unique product number search),
        // just list them.
        const detailLines = products.map((p) => `• ${p.name}`);
        return {
            structuredContent: allStructured,
            content: [
                {
                    type: 'text',
                    text: `Found ${total} product(s):\n${detailLines.join('\n')}`
                }
            ]
        };
    });
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
    serverInstance.registerTool('get-stock-level', {
        title: 'Get stock level',
        description: 'Return the available stock for a product identified by its product number',
        inputSchema: {
            productNumber: zod_1.z.string().describe('The product number (SKU) to check')
        },
        outputSchema: {
            productNumber: zod_1.z.string(),
            availableStock: zod_1.z.number().nullable()
        }
    }, async ({ productNumber }) => {
        const result = await fastifyInstance.shopware.searchProductsByNumber(productNumber, true);
        if (!result || (result.total ?? 0) === 0) {
            return {
                structuredContent: null,
                content: [
                    {
                        type: 'text',
                        text: `Product with number "${productNumber}" not found.`
                    }
                ]
            };
        }
        // Use the first matching product (most searches will be unique)
        const product = result.data[0];
        const availableStock = product.availableStock ?? product.stock ?? null;
        const payload = {
            productNumber,
            availableStock
        };
        const stockTxt = availableStock != null ? `${availableStock}` : 'n/a';
        return {
            structuredContent: payload,
            content: [
                {
                    type: 'text',
                    text: `${stockTxt} units are available.`.trim()
                }
            ]
        };
    });
    serverInstance.registerTool('check-order-status', {
        title: 'Check order status',
        description: 'Return a customer-friendly order status and delivery estimate for a given order number',
        inputSchema: {
            orderNumber: zod_1.z.string().describe('The order number to check')
        },
        outputSchema: {
            orderNumber: zod_1.z.string(),
            statusText: zod_1.z.string(),
            deliveryEstimate: zod_1.z.string().nullable()
        }
    }, async ({ orderNumber }) => {
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
        };
        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);
        // Early exit if no order found
        if (cleaned.total === 0) {
            return {
                structuredContent: null,
                content: [{ type: 'text', text: `Order #${orderNumber} not found.` }]
            };
        }
        const essential = mapEssentials(cleaned.data[0]);
        // Helper: convert internal status to a customer-friendly sentence
        const getCustomerFriendlyStatus = (status) => {
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
                case 'versandt': // German: shipped
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
        const calculateDeliveryEstimate = (_order) => {
            const shippingState = (_order.status.shipping ?? _order.status.overall ?? '').toString().toLowerCase();
            if (!shippingState)
                return null;
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
        };
        return {
            structuredContent: payload,
            content: [
                {
                    type: 'text',
                    text: `**Order #${orderNumber}**\n${statusText}${deliveryEstimate ? `\nEstimated delivery: ${deliveryEstimate}` : ''}`
                }
            ]
        };
    });
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
    serverInstance.registerTool('check-payment-status', {
        title: 'Check payment status',
        description: 'Return a customer-friendly payment status for a given order number',
        inputSchema: {
            orderNumber: zod_1.z.string().describe('The order number to check')
        },
        outputSchema: {
            orderNumber: zod_1.z.string(),
            paymentStatusText: zod_1.z.string(),
            paymentMethod: zod_1.z.string().nullable()
        }
    }, async ({ orderNumber }) => {
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
        };
        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);
        if (cleaned.total === 0) {
            return {
                structuredContent: null,
                content: [{ type: 'text', text: `Order #${orderNumber} not found.` }]
            };
        }
        const order = cleaned.data[0];
        const firstTx = order.transactions?.[0] ?? {};
        const paymentStateRaw = firstTx.stateMachineState?.name ?? 'unknown';
        const paymentState = paymentStateRaw.toString().toLowerCase();
        const paymentMethodName = firstTx.paymentMethod?.name ?? null;
        const getFriendlyPaymentStatus = (state) => {
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
        };
        const methodLine = paymentMethodName ? `Payment method: ${paymentMethodName}\n` : '';
        return {
            structuredContent: payload,
            content: [
                {
                    type: 'text',
                    text: `**Order #${orderNumber}**\n${paymentStatusText}\n${methodLine}`.trimEnd()
                }
            ]
        };
    });
    // -------------------- Order items tool --------------------
    /**
     * Tool: get-order-items
     * ---------------------
     * Simple helper that returns the line items of a given order (name, SKU,
     * quantity, total price). Useful for follow-up questions after an order search.
     */
    serverInstance.registerTool('get-order-items', {
        title: 'Get order items',
        description: 'Return the list of items (name, SKU, quantity, price) for a given order number',
        inputSchema: {
            orderNumber: zod_1.z.string().describe('The order number to retrieve items for')
        },
        outputSchema: {
            orderNumber: zod_1.z.string(),
            items: zod_1.z.array(zod_1.z.object({
                name: zod_1.z.string().nullable(),
                productNumber: zod_1.z.string().nullable(),
                quantity: zod_1.z.number(),
                totalPrice: zod_1.z.number()
            }))
        }
    }, async ({ orderNumber }) => {
        const criteria = {
            filter: [{ type: 'equals', field: 'orderNumber', value: orderNumber }],
            associations: {
                lineItems: {
                    associations: { product: {} }
                }
            }
        };
        const result = await fastifyInstance.shopware.searchOrders(criteria);
        const cleaned = stripExtensionsDeep(result);
        if (cleaned.total === 0) {
            const emptyPayload = { orderNumber, items: [] };
            return {
                structuredContent: emptyPayload,
                content: withStructuredJson(emptyPayload, [
                    { type: 'text', text: `Order #${orderNumber} not found.` }
                ])
            };
        }
        const orderData = cleaned.data[0];
        const items = (orderData.lineItems || []).map((li) => ({
            name: li.product?.translated?.name ?? li.product?.name ?? li.label ?? null,
            productNumber: li.product?.productNumber ?? li.payload?.productNumber ?? null,
            quantity: li.quantity,
            totalPrice: li.totalPrice
        }));
        const payload = { orderNumber, items };
        const itemsLines = items
            .map((it) => `• ${it.quantity} × ${it.name ?? 'n/a'} – ${it.totalPrice}`)
            .join('\n');
        return {
            structuredContent: payload,
            content: withStructuredJson(payload, [
                {
                    type: 'text',
                    text: `Items for order #${orderNumber}:\n${itemsLines}`
                }
            ])
        };
    });
    // -------------------- Product name search tool --------------------
    serverInstance.registerTool('search-product-vector', {
        title: 'Search product by name (vector)',
        description: 'Fuzzy vector search over product names via LanceDB',
        inputSchema: {
            name: zod_1.z.string().describe('Partial or full product name'),
            vehicleBrand: zod_1.z.string().describe('Vehicle brand to filter results'),
            vehicleModel: zod_1.z.string().describe('Vehicle model to filter results'),
            vehicleVariant: zod_1.z.string().optional().describe('Vehicle variant to filter results')
        },
        outputSchema: {
            total: zod_1.z.number(),
            products: zod_1.z.array(zod_1.z.object({
                productNumber: zod_1.z.string(),
                productName: zod_1.z.string(),
                vehicleBrand: zod_1.z.string(),
                vehicleModel: zod_1.z.string(),
                vehicleVariant: zod_1.z.string()
            })).describe('List of matching products with vehicle details')
        }
    }, async ({ name, vehicleBrand, vehicleModel, vehicleVariant }) => {
        try {
            // Embed the query
            const queryEmbedding = await (0, embed_1.embed)(name);
            // Access the pre-opened LanceDB products table
            const table = fastifyInstance.lance.productsTable;
            // Perform vector search and load metadata columns
            let hits = await table.search(queryEmbedding)
                .select([
                'productNumber',
                'productName',
                'vehicleBrand',
                'vehicleModel',
                'vehicleVariant'
            ])
                .toArray();
            // Filter by brand and model
            hits = hits.filter((r) => r.vehicleBrand.toLowerCase().includes(vehicleBrand.toLowerCase()) &&
                r.vehicleModel.toLowerCase().includes(vehicleModel.toLowerCase()));
            // If variant provided, further filter by variant
            if (vehicleVariant) {
                hits = hits.filter((r) => r.vehicleVariant.toLowerCase().includes(vehicleVariant.toLowerCase()));
            }
            // Map results
            const products = hits.map((r) => ({
                productNumber: r.productNumber,
                productName: r.productName,
                vehicleBrand: r.vehicleBrand,
                vehicleModel: r.vehicleModel,
                vehicleVariant: r.vehicleVariant
            }));
            const total = products.length;
            const structured = { total, products };
            if (total > 1) {
                const variantLines = products
                    .map((p) => {
                    const cleanName = p.productName.replace(/^JAEGER automotive\s*/i, '').trim();
                    return `• [${p.productNumber}] ${cleanName} – ${p.vehicleBrand} ${p.vehicleModel} ${p.vehicleVariant}`;
                })
                    .join('\n');
                return {
                    structuredContent: structured,
                    content: [
                        {
                            type: 'text',
                            text: `Found ${total} items for '${name}':\n${variantLines}`
                        }
                    ]
                };
            }
            if (total === 1) {
                const p = products[0];
                const cleanName = p.productName.replace(/^JAEGER automotive\s*/i, '').trim();
                return {
                    structuredContent: structured,
                    content: [
                        {
                            type: 'text',
                            text: `Found one product: [${p.productNumber}] ${cleanName} – ${p.vehicleBrand} ${p.vehicleModel} ${p.vehicleVariant}`
                        }
                    ]
                };
            }
            // No matches
            return {
                structuredContent: structured,
                content: [
                    {
                        type: 'text',
                        text: `No products found for "${name}".`
                    }
                ]
            };
        }
        catch (err) {
            fastifyInstance.log.error(err);
            const empty = { total: 0, products: [] };
            return {
                structuredContent: empty,
                content: [
                    { type: 'text', text: `Vector search failed: ${err.message}` }
                ]
            };
        }
    });
    // (Additional tools can be registered here)
};
// Stateless MCP endpoint using the above tools
const registerMcp = (0, fastify_plugin_1.default)(async (fastify) => {
    fastify.post('/mcp', async (request, reply) => {
        reply.hijack();
        const mcpServer = new mcp_js_1.McpServer({ name: 'shopware-mcp', version: '0.1.0' });
        registerTools(fastify, mcpServer);
        const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });
        reply.raw.on('close', async () => {
            await transport.close();
            await mcpServer.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(request.raw, reply.raw, request.body);
    });
    const methodNotAllowed = (reply) => {
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
exports.registerMcp = registerMcp;
