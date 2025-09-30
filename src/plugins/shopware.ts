import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { loadConfig } from '../config';
import { ShopwareAdminClient } from '../shopware/adminClient';

// Extend Fastify type
declare module 'fastify' {
  interface FastifyInstance {
    shopware: ShopwareAdminClient;
  }
}

export const registerShopware: FastifyPluginAsync = fp(async (fastify) => {
  const env = loadConfig();
  const client = new ShopwareAdminClient({
    baseUrl: env.SHOPWARE_API_URL,
    accessKeyId: env.SHOPWARE_ACCESS_KEY_ID,
    secretAccessKey: env.SHOPWARE_SECRET_ACCESS_KEY
  });

  fastify.decorate('shopware', client);
}); 
