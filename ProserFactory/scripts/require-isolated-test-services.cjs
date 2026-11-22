/** Runs before Jest's dotenv setup, so host .env cannot authorize DB tests. */
function validateIsolatedTestServices(environment) {
  let database;
  let redis;
  try {
    database = new URL(environment.DATABASE_URL || 'invalid:');
    redis = new URL(environment.REDIS_URL || 'invalid:');
  } catch {
    throw new Error('Database-backed tests require explicitly configured isolated fixture services.');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || database.port !== '55441' || !/^\/proser_canvas_[a-zA-Z0-9_]+$/.test(database.pathname) || redis.protocol !== 'redis:' || redis.hostname !== '127.0.0.1' || redis.port !== '56441') {
    throw new Error('Refusing database-backed tests: explicitly use isolated PostgreSQL127.0.0.1:55441/proser_canvas_* and Redis127.0.0.1:56441. Host .env is not authorization.');
  }
}
module.exports = async () => validateIsolatedTestServices(process.env);
module.exports.validateIsolatedTestServices = validateIsolatedTestServices;
