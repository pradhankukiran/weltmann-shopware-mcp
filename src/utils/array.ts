/**
 * Safe array access utilities
 */

/**
 * Safely get the first element of an array, returning undefined if empty.
 */
export function first<T>(arr: T[] | undefined | null): T | undefined {
  return arr && arr.length > 0 ? arr[0] : undefined;
}

/**
 * Safely get the first element of an array, throwing an error if empty.
 * Use when the array is expected to have at least one element.
 */
export function firstOrThrow<T>(
  arr: T[] | undefined | null,
  message = 'Expected non-empty array'
): T {
  const item = first(arr);
  if (item === undefined) {
    throw new Error(message);
  }
  return item;
}

/**
 * Safely get the first element of an array with a default value.
 */
export function firstOr<T>(arr: T[] | undefined | null, defaultValue: T): T {
  return first(arr) ?? defaultValue;
}
