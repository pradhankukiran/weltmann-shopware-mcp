/**
 * TypeScript interfaces for Shopware Admin API responses
 */

/**
 * Common Shopware entity fields
 */
export interface ShopwareEntity {
  id: string;
  versionId?: string;
  extensions?: Record<string, unknown>;
  _uniqueIdentifier?: string;
}

/**
 * Shopware paginated response wrapper
 */
export interface ShopwareSearchResponse<T> {
  total: number;
  data: T[];
  aggregations?: Record<string, unknown>;
}

/**
 * State machine state
 */
export interface StateMachineState {
  name?: string | null;
  technicalName?: string | null;
}

/**
 * Address entity
 */
export interface ShopwareAddress {
  street?: string;
  zipcode?: string;
  city?: string;
  company?: string | null;
  phoneNumber?: string | null;
  country?: {
    name?: string;
  };
}

/**
 * Product entity from Shopware Admin API
 */
export interface ShopwareProduct extends ShopwareEntity {
  name: string;
  productNumber: string;
  description?: string | null;
  stock?: number | null;
  availableStock?: number | null;
  active?: boolean;
  translated?: {
    name?: string;
    description?: string;
  };
}

/**
 * Order customer details
 */
export interface OrderCustomer {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  customerNumber?: string | null;
  customerId?: string;
}

/**
 * Delivery entity
 */
export interface OrderDelivery {
  stateMachineState?: StateMachineState;
  shippingOrderAddress?: ShopwareAddress;
  trackingCodes?: string[];
  shippingMethod?: {
    name?: string;
    description?: string;
  };
}

/**
 * Transaction entity
 */
export interface OrderTransaction {
  stateMachineState?: StateMachineState;
  paymentMethod?: {
    name?: string;
  };
}

/**
 * Line item product
 */
export interface LineItemProduct {
  name?: string;
  productNumber?: string;
  description?: string | null;
  translated?: {
    name?: string;
    description?: string;
  };
}

/**
 * Order line item
 */
export interface LineItem {
  product?: LineItemProduct;
  label?: string;
  productId?: string;
  payload?: {
    productNumber?: string;
  };
  quantity: number;
  totalPrice: number;
}

/**
 * Sales channel
 */
export interface SalesChannel {
  name?: string;
}

/**
 * Full order entity from Shopware Admin API
 */
export interface ShopwareOrder extends ShopwareEntity {
  orderNumber: string;
  orderDateTime: string;
  amountTotal?: number;
  shippingTotal?: number;
  stateId?: string;
  stateMachineState?: StateMachineState;
  orderCustomer?: OrderCustomer;
  salesChannel?: SalesChannel;
  deliveries?: OrderDelivery[];
  transactions?: OrderTransaction[];
  lineItems?: LineItem[];
}

/**
 * Customer entity from Shopware Admin API
 */
export interface ShopwareCustomer extends ShopwareEntity {
  customerNumber?: string | null;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  active?: boolean;
  defaultBillingAddress?: ShopwareAddress | null;
  defaultShippingAddress?: ShopwareAddress | null;
}

/**
 * Mapped order essentials (output of mapOrderEssentials)
 */
export interface OrderEssentials {
  customer: {
    orderNumber: string;
    orderDateTime: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    customerNumber: string | null;
    salesChannel: string | null;
  };
  status: {
    overall: string | null;
    payment: string | null;
    shipping: string | null;
  };
  shipping: {
    address: {
      street?: string;
      zipcode?: string;
      city?: string;
      company?: string | null;
      phoneNumber?: string | null;
      country: string | null;
    } | null;
    trackingCodes: string[];
    shippingMethod: {
      name: string | null;
      description: string | null;
    };
  };
  items: Array<{
    name: string | null;
    description: string;
    productNumber: string | null;
    quantity: number;
    totalPrice: number;
  }>;
  totals: {
    amountTotal: number | null;
    shippingTotal: number | null;
    paymentMethod: string | null;
  };
}

/**
 * Shopware search filter
 */
export interface ShopwareFilter {
  type: string;
  field?: string;
  value?: unknown;
  operator?: string;
  queries?: ShopwareFilter[];
}

/**
 * Shopware search criteria
 */
export interface ShopwareCriteria {
  filter?: ShopwareFilter[];
  associations?: Record<string, ShopwareCriteria | object>;
  includes?: Record<string, string[]>;
  page?: number;
  limit?: number;
  sort?: Array<{
    field: string;
    order: 'ASC' | 'DESC';
  }>;
  term?: string;
}
