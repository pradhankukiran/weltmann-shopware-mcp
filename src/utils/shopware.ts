/**
 * Shopware-specific utility functions
 */

import { stripHtml } from './strings';
import { first } from './array';
import type { ShopwareOrder, OrderEssentials, LineItem } from '../types/shopware';

/**
 * Recursively remove Shopware housekeeping keys (extensions, _uniqueIdentifier, etc.)
 * from objects and arrays.
 */
export function stripExtensionsDeep<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map(item => stripExtensionsDeep(item)) as T;
  }

  if (input && typeof input === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extensions, _uniqueIdentifier, versionId, translated, ...rest } =
      input as Record<string, unknown>;
    for (const key of Object.keys(rest)) {
      rest[key] = stripExtensionsDeep(rest[key]);
    }
    return rest as T;
  }

  return input;
}

/**
 * Map a raw Shopware order to a compact essentials-only view.
 */
export function mapOrderEssentials(order: ShopwareOrder): OrderEssentials {
  const firstDelivery = first(order.deliveries) ?? {};
  const firstTransaction = first(order.transactions) ?? {};

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
    items: (order.lineItems || []).map((li: LineItem) => ({
      name: li.product?.translated?.name ?? li.product?.name ?? li.label ?? null,
      description: stripHtml(li.product?.translated?.description ?? li.product?.description),
      productNumber: li.product?.productNumber ?? li.payload?.productNumber ?? li.productId ?? null,
      quantity: li.quantity,
      totalPrice: li.totalPrice
    })),
    totals: {
      amountTotal: order.amountTotal ?? null,
      shippingTotal: order.shippingTotal ?? null,
      paymentMethod: firstTransaction.paymentMethod?.name ?? null
    }
  };
}
