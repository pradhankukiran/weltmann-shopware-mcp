import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import * as lancedb from '@lancedb/lancedb';

// Extend Fastify type to include lance client
declare module 'fastify' {
  interface FastifyInstance {
    lance: {
      productsTable: lancedb.Table;
    };
  }
}

export const registerLanceDB: FastifyPluginAsync = fp(async (fastify) => {
  // Resolve path to the LanceDB store (persistent vector database)
  const dbPath = path.resolve(process.cwd(), 'lancedb');

  // Connect to LanceDB (creates directory if it doesn't exist)
  const db = await (lancedb as any).connect(dbPath);

  // Open the products table
  const productsTable = await db.openTable('products');

  // Decorate Fastify with the lance client
  fastify.decorate('lance', { productsTable });
  fastify.log.info(`LanceDB store opened at ${dbPath} and 'products' table is ready.`);
}); 