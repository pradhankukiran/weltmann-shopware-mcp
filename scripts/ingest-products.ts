import fs from 'fs';
import 'dotenv/config';
import path from 'path';
import { parse } from 'csv-parse';
import OpenAI from 'openai';
import * as lancedb from '@lancedb/lancedb';
import * as arrow from 'apache-arrow';

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
  const db = await (lancedb as any).connect(dbPath);
  
  let schema: arrow.Schema | null = null;
  let table: any = null;
  let totalProcessed = 0;
  let currentBatch: Array<{productNumber: string; productName: string; vehicleBrand: string; vehicleModel: string; vehicleVariant: string;}> = [];
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
  batch: Array<{productNumber: string; productName: string; vehicleBrand: string; vehicleModel: string; vehicleVariant: string;}>,
  openai: OpenAI,
  model: string,
  db: any,
  schema: arrow.Schema | null,
  table: any,
  offset: number,
  isFirstBatch: boolean
): Promise<{schema: arrow.Schema | null; table: any}> {
  console.log(`Processing batch: rows ${offset + 1}-${offset + batch.length}`);
  
  const inputs = batch.map(r =>
    `${r.productName} | ${r.vehicleBrand} | ${r.vehicleModel} | ${r.vehicleVariant}`
  );
  
  let resp;
  let retries = 3;
  while (retries > 0) {
    try {
      resp = await openai.embeddings.create({ model, input: inputs });
      break;
    } catch (error) {
      retries--;
      console.warn(`Embedding API error (${retries} retries left):`, error);
      if (retries === 0) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (4 - retries))); // Exponential backoff
    }
  }
  
  if (!resp) {
    throw new Error('Failed to get embeddings response after retries');
  }
  
  const records = resp.data.map((item, idx) => ({
    productNumber: batch[idx].productNumber,
    productName: batch[idx].productName,
    vehicleBrand: batch[idx].vehicleBrand,
    vehicleModel: batch[idx].vehicleModel,
    vehicleVariant: batch[idx].vehicleVariant,
    vector: item.embedding as number[]
  }));

  if (isFirstBatch) {
    // Create table with schema on first batch
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
          new arrow.Field('item', new arrow.Float32(), false),
        ),
        false,
      ),
    ]);
    
    const newTable = await db.createTable('products', records, { schema: newSchema, mode: 'overwrite' });
    console.log(`Created table with ${records.length} initial records`);
    
    return { schema: newSchema, table: newTable };
  } else {
    // Add to existing table
    await table.add(records);
    console.log(`Added ${records.length} records to table`);
    
    return { schema, table };
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}); 