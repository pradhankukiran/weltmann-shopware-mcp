import path from 'path';

import { connect, type Connection, type Table } from '@lancedb/lancedb';
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';

// Extend Fastify type to include lance client
declare module 'fastify' {
  interface FastifyInstance {
    lance: {
      productsTable: Table;
    };
  }
}

export const registerLanceDB: FastifyPluginAsync = fp(async (fastify) => {
  // Resolve path to the LanceDB store (persistent vector database)
  const dbPath = path.resolve(process.cwd(), 'lancedb');

  // Connect to LanceDB (creates directory if it doesn't exist)
  const db: Connection = await connect(dbPath);

  // Open the products table
  const productsTable = await db.openTable('products');

  // Decorate Fastify with the lance client
  fastify.decorate('lance', { productsTable });
  fastify.log.info(`LanceDB store opened at ${dbPath} and 'products' table is ready.`);
}); 
