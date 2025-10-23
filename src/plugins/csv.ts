import path from 'path';
import fs from 'fs';

import Papa from 'papaparse';
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';

export interface Product {
  productNumber: string;
  productName: string;
  vehicleBrand: string;
  vehicleModel: string;
  vehicleVariant: string;
}

// Extend Fastify type to include products
declare module 'fastify' {
  interface FastifyInstance {
    products: Product[];
  }
}

export const registerCSV: FastifyPluginAsync = fp(async (fastify) => {
  // Resolve path to the CSV file
  const csvPath = path.resolve(process.cwd(), 'data', 'weltmannproducts.csv');

  // Check if file exists
  if (!fs.existsSync(csvPath)) {
    fastify.log.error(`CSV file not found at ${csvPath}`);
    throw new Error(`CSV file not found at ${csvPath}`);
  }

  // Read CSV file
  const csvContent = fs.readFileSync(csvPath, 'utf-8');

  // Parse CSV
  const parsed = Papa.parse<Product>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  if (parsed.errors.length > 0) {
    fastify.log.error('CSV parsing errors:', parsed.errors);
    throw new Error('Failed to parse CSV file');
  }

  // Clean up data - remove BOM and trim values
  const products = parsed.data.map((p) => ({
    productNumber: p.productNumber?.trim() || '',
    productName: p.productName?.trim() || '',
    vehicleBrand: p.vehicleBrand?.trim() || '',
    vehicleModel: p.vehicleModel?.trim() || '',
    vehicleVariant: p.vehicleVariant?.trim() || ''
  }));

  // Decorate Fastify with the products array
  fastify.decorate('products', products);
  fastify.log.info(`Loaded ${products.length} products from ${csvPath}`);
});
