/**
 * Convert BigInt values to strings for JSON serialization
 * @param {any} obj - Object to convert
 * @returns {any} Object with BigInts converted to strings
 */
export function serializeBigInt(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(item => serializeBigInt(item));
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        result[key] = serializeBigInt(obj[key]);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Setup BigInt JSON serialization globally
 */
export function setupBigIntSerialization() {
  // Override BigInt.prototype.toJSON
  // eslint-disable-next-line no-extend-native
  BigInt.prototype.toJSON = function () {
    return this.toString();
  };
}
