import redis from './redis.js';

/**
 * ERC-8128 NonceStore backed by Upstash Redis.
 * Implements the NonceStore interface: { consume(key, ttlSeconds): Promise<boolean> }
 * Returns true if the nonce was newly stored (first use), false if already seen (replay).
 */
const nonceStore = {
  async consume(key, ttlSeconds) {
    if (!redis) {
      // If Redis is not configured, allow all requests (dev mode)
      console.warn('NonceStore: Redis not configured, allowing request');
      return true;
    }

    const redisKey = `nonce:${key}`;
    // Atomic set-if-not-exists with TTL — returns 'OK' if set, null if already exists
    const result = await redis.set(redisKey, '1', { nx: true, ex: ttlSeconds });
    return result === 'OK';
  },
};

export default nonceStore;
