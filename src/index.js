import { config } from './config.js';
import { logger } from './logger.js';
import { SessionManager } from './manager.js';
import { buildServer } from './server.js';

async function main() {
  const manager = new SessionManager();
  const app = buildServer(manager);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, laravel: config.laravelUrl }, 'Overcloud WhatsApp gateway listening');
  });

  // Resume any previously-connected numbers.
  await manager.loadPersisted();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    for (const session of manager.sessions.values()) {
      await session.stop().catch(() => {});
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err, 'fatal');
  process.exit(1);
});
