import Redis from 'ioredis';
import logger from '../logger';

const options = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  showFriendlyErrorStack: true,
  connectTimeout: 5000
};
// Use the same configured database/auth/TLS destination as BullMQ. A URL must
// not silently fall back to localhost for caches or readiness probes.
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, options) : new Redis(options);

redis.on('connect', () => {
  logger.info('Redis connected successfully');
});

redis.on('ready', () => {
  logger.info('Redis ready to receive commands');
});

redis.on('error', (err) => {
  logger.error({ error: err.message }, 'Redis connection error');
});

redis.on('close', () => {
  logger.warn('Redis connection closed');
});

redis.on('reconnecting', () => {
  logger.info('Redis reconnecting...');
});

export default redis;
