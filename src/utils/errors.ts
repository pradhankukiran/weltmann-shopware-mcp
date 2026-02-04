/**
 * Error handling utilities for safe error messages
 */

import axios, { AxiosError } from 'axios';
import { ZodError } from 'zod';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Custom error class for Shopware API errors
 */
export class ShopwareApiError extends Error {
  public readonly statusCode?: number;
  public readonly endpoint: string;
  public readonly originalError?: Error;

  constructor(
    message: string,
    endpoint: string,
    statusCode?: number,
    originalError?: Error
  ) {
    super(message);
    this.name = 'ShopwareApiError';
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}

/**
 * Safe error messages for clients - never expose internal details
 */
const GENERIC_ERROR_MESSAGES: Record<string, string> = {
  NETWORK: 'Service temporarily unavailable. Please try again.',
  AUTH: 'Authentication failed. Please check your credentials.',
  VALIDATION: 'Invalid request parameters.',
  NOT_FOUND: 'The requested resource was not found.',
  RATE_LIMIT: 'Too many requests. Please slow down.',
  INTERNAL: 'An unexpected error occurred. Please try again later.'
};

export interface SanitizedError {
  message: string;
  code: string;
  isRetryable: boolean;
}

/**
 * Check if an error is an Axios error
 */
function isAxiosError(error: unknown): error is AxiosError {
  return axios.isAxiosError(error);
}

/**
 * Sanitize error for client response - strips sensitive info
 */
export function sanitizeErrorForClient(error: unknown): SanitizedError {
  // Network/connection errors
  if (isAxiosError(error)) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return {
        message: GENERIC_ERROR_MESSAGES.NETWORK,
        code: 'NETWORK_ERROR',
        isRetryable: true
      };
    }
    if (error.response?.status === 401 || error.response?.status === 403) {
      return {
        message: GENERIC_ERROR_MESSAGES.AUTH,
        code: 'AUTH_ERROR',
        isRetryable: false
      };
    }
    if (error.response?.status === 404) {
      return {
        message: GENERIC_ERROR_MESSAGES.NOT_FOUND,
        code: 'NOT_FOUND',
        isRetryable: false
      };
    }
    if (error.response?.status === 429) {
      return {
        message: GENERIC_ERROR_MESSAGES.RATE_LIMIT,
        code: 'RATE_LIMIT',
        isRetryable: true
      };
    }
  }

  // Zod validation errors
  if (error instanceof ZodError) {
    return {
      message: GENERIC_ERROR_MESSAGES.VALIDATION,
      code: 'VALIDATION_ERROR',
      isRetryable: false
    };
  }

  // ShopwareApiError - use the message but don't expose endpoint details
  if (error instanceof ShopwareApiError) {
    // For auth errors, return generic message
    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        message: GENERIC_ERROR_MESSAGES.AUTH,
        code: 'AUTH_ERROR',
        isRetryable: false
      };
    }
    // For not found, keep it informative but safe
    if (error.statusCode === 404) {
      return {
        message: GENERIC_ERROR_MESSAGES.NOT_FOUND,
        code: 'NOT_FOUND',
        isRetryable: false
      };
    }
    // Otherwise use a sanitized version of the message
    return {
      message: error.message.replace(/https?:\/\/[^\s]+/g, '[url]'),
      code: 'API_ERROR',
      isRetryable: true
    };
  }

  // Default: never expose raw error messages
  return {
    message: GENERIC_ERROR_MESSAGES.INTERNAL,
    code: 'INTERNAL_ERROR',
    isRetryable: true
  };
}

/**
 * Log error with full details server-side (safe for logs)
 */
export function logErrorDetails(
  logger: FastifyBaseLogger,
  error: unknown,
  context: string
): void {
  const errorDetails: Record<string, unknown> = {
    context,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    name: error instanceof Error ? error.name : undefined
  };

  // For axios errors, include response details (but not request body which may have secrets)
  if (axios.isAxiosError(error)) {
    errorDetails.status = error.response?.status;
    errorDetails.url = error.config?.url;
    errorDetails.method = error.config?.method;
  }

  // For ShopwareApiError, include endpoint
  if (error instanceof ShopwareApiError) {
    errorDetails.endpoint = error.endpoint;
    errorDetails.statusCode = error.statusCode;
  }

  logger.error(errorDetails, 'Error occurred');
}
