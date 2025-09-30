import 'dotenv/config';

import fs from 'fs';
import path from 'path';

import * as arrow from 'apache-arrow';
import { parse } from 'csv-parse';
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import OpenAI from 'openai';

type ProductMetadata = {
  productNumber: string;
  productName: string;
  vehicleBrand: string;
  vehicleModel: string;
  vehicleVariant: string;
};
type ProductRecord = ProductMetadata & { vector: number[] };
type EmbeddingResponse = Awaited<ReturnType<OpenAI['embeddings']['create']>>;

async function main() {
  const csvPath = path.resolve(__dirname, '../data/weltmannproducts.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found at ${csvPath}`);
    process.exit(1);
  }

  const openai = new OpenAI();
  const model = 'text-embedding-3-large';
  const batchSize = 50; // Reduced batch size for better memory management
  const dbPath = path.resolve(__dirname, '../lancedb');
  const db: Connection = await connect(dbPath);
  
  let schema: arrow.Schema | null = null;
  let table: Table | null = null;
  let totalProcessed = 0;
  let currentBatch: ProductMetadata[] = [];
  let isFirstBatch = true;

  console.log(`Starting ingestion with batch size: ${batchSize}`);
  logMemoryUsage('Initial');
  
  const parser = fs.createReadStream(csvPath).pipe(parse({ columns: true, trim: true, bom: true }));
  
  for await (const row of parser) {
    currentBatch.push({
      productNumber: row.productNumber as string,
      productName: row.productName as string,
      vehicleBrand: row.vehicleBrand as string,
      vehicleModel: row.vehicleModel as string,
      vehicleVariant: row.vehicleVariant as string
    });

    if (currentBatch.length >= batchSize) {
      const result = await processBatch(currentBatch, openai, model, db, schema, table, totalProcessed, isFirstBatch);
      
      if (isFirstBatch) {
        schema = result.schema;
        table = result.table;
        isFirstBatch = false;
      }
      
      totalProcessed += currentBatch.length;
      currentBatch = [];
      
      // Force garbage collection to free memory
      if (global.gc) {
        global.gc();
      }
      
      // Log memory usage every 10 batches
      if ((totalProcessed / batchSize) % 10 === 0) {
        logMemoryUsage(`After ${totalProcessed} records`);
      }
    }
  }

  // Process remaining batch
  if (currentBatch.length > 0) {
    const result = await processBatch(currentBatch, openai, model, db, schema, table, totalProcessed, isFirstBatch);
    
    if (isFirstBatch) {
      schema = result.schema;
      table = result.table;
    }
    
    totalProcessed += currentBatch.length;
  }

  logMemoryUsage('Final');
  console.log(`Successfully ingested ${totalProcessed} products into LanceDB at ${dbPath}`);
}

function logMemoryUsage(stage: string) {
  const used = process.memoryUsage();
  console.log(`[${stage}] Memory usage:`, {
    rss: `${Math.round(used.rss / 1024 / 1024 * 100) / 100} MB`,
    heapUsed: `${Math.round(used.heapUsed / 1024 / 1024 * 100) / 100} MB`,
    heapTotal: `${Math.round(used.heapTotal / 1024 / 1024 * 100) / 100} MB`,
    external: `${Math.round(used.external / 1024 / 1024 * 100) / 100} MB`
  });
}


async function processBatch(
  batch: ProductMetadata[],
  openai: OpenAI,
  model: string,
  db: Connection,
  schema: arrow.Schema | null,
  table: Table | null,
  offset: number,
  isFirstBatch: boolean
): Promise<{ schema: arrow.Schema; table: Table }> {
  console.log(`Processing batch: rows ${offset + 1}-${offset + batch.length}`);

  const inputs = batch.map(record =>
    `${record.productName} | ${record.vehicleBrand} | ${record.vehicleModel} | ${record.vehicleVariant}`
  );

  let response: EmbeddingResponse | null = null;
  let retries = 3;

  while (retries > 0) {
    try {
      response = await openai.embeddings.create({ model, input: inputs });
      break;
    } catch (error) {
      retries -= 1;
      console.warn(`Embedding API error (${retries} retries left):`, error);
      if (retries === 0) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries))); // Exponential backoff
    }
  }

  if (!response) {
    throw new Error('Failed to get embeddings response after retries');
  }

  const records: ProductRecord[] = response.data.map((item, idx) => ({
    productNumber: batch[idx].productNumber,
    productName: batch[idx].productName,
    vehicleBrand: batch[idx].vehicleBrand,
    vehicleModel: batch[idx].vehicleModel,
    vehicleVariant: batch[idx].vehicleVariant,
    vector: item.embedding
  }));

  if (isFirstBatch) {
    const vectorDim = records[0].vector.length;
    const newSchema = new arrow.Schema([
      new arrow.Field('productNumber', new arrow.Utf8(), false),
      new arrow.Field('productName', new arrow.Utf8(), false),
      new arrow.Field('vehicleBrand', new arrow.Utf8(), false),
      new arrow.Field('vehicleModel', new arrow.Utf8(), false),
      new arrow.Field('vehicleVariant', new arrow.Utf8(), false),
      new arrow.Field(
        'vector',
        new arrow.FixedSizeList(
          vectorDim,
          new arrow.Field('item', new arrow.Float32(), false)
        ),
        false
      )
    ]);

    const newTable = await db.createTable('products', records, { schema: newSchema, mode: 'overwrite' });
    console.log(`Created table with ${records.length} initial records`);

    return { schema: newSchema, table: newTable };
  }

  if (!schema || !table) {
    throw new Error('Existing LanceDB schema and table are required after the first batch');
  }

  await table.add(records);
  console.log(`Added ${records.length} records to table`);

  return { schema, table };
}


main().catch(err => {
  console.error(err);
  process.exit(1);
}); 
