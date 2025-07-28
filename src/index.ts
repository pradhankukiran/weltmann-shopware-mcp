import fastify from 'fastify';
import { registerSwagger } from './plugins/swagger';
import { loadConfig } from './config';

async function buildServer() {
  const config = loadConfig();
  const app = fastify({ logger: true });

  // Register plugins
  await app.register(registerSwagger);
  await app.register((await import('./plugins/shopware')).registerShopware);

  // Register routes
  await app.register((await import('./routes/products')).default);
  await app.register((await import('./routes/orders')).default);

  // LanceDB plugin (vector store)
  await app.register((await import('./plugins/lancedb')).registerLanceDB);

  // MCP plugin (streamable HTTP)
  await app.register((await import('./plugins/mcp')).registerMcp);

  // Healthcheck route
  app.get('/healthz', async () => {
    return { status: 'ok', up: true } as const;
  });

  return { app, config } as const;
}

async function start() {
  const { app, config } = await buildServer();

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Server listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start(); 