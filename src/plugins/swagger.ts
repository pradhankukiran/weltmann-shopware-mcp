import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

export const registerSwagger: FastifyPluginAsync = fp(async (fastify) => {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'Shopware MCP API',
        version: '1.0.0'
      }
    }
  });

  await fastify.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false
    }
  });
}); 
