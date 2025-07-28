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

  // Read all CSV rows into memory
  const rawRows: Array<{productNumber: string; productName: string; vehicleBrand: string; vehicleModel: string; vehicleVariant: string;}> = [];
  const parser = fs.createReadStream(csvPath).pipe(parse({ columns: true, trim: true, bom: true }));
  for await (const row of parser) {
    rawRows.push({
      productNumber: row.productNumber as string,
      productName:  row.productName as string,
      vehicleBrand: row.vehicleBrand as string,
      vehicleModel: row.vehicleModel as string,
      vehicleVariant: row.vehicleVariant as string
    });
  }

  const openai = new OpenAI();
  const records: Array<{productNumber: string; productName: string; vehicleBrand: string; vehicleModel: string; vehicleVariant: string; vector: number[]}> = [];
  const model = 'text-embedding-3-large';
  const batchSize = 100;

  // Batch embedding requests to speed up ingestion
  for (let i = 0; i < rawRows.length; i += batchSize) {
    const batch = rawRows.slice(i, i + batchSize);
    const inputs = batch.map(r =>
      `${r.productName} | ${r.vehicleBrand} | ${r.vehicleModel} | ${r.vehicleVariant}`
    );
    const resp = await openai.embeddings.create({ model, input: inputs });
    resp.data.forEach((item, idx) => {
      records.push({
        productNumber:   batch[idx].productNumber,
        productName:     batch[idx].productName,
        vehicleBrand:    batch[idx].vehicleBrand,
        vehicleModel:    batch[idx].vehicleModel,
        vehicleVariant:  batch[idx].vehicleVariant,
        vector:          item.embedding as number[]
      });
    });
    console.log(`Processed embeddings for rows ${i + 1}-${Math.min(i + batchSize, rawRows.length)}`);
  }

  // Connect to LanceDB store (creates ./lancedb if missing)
  const dbPath = path.resolve(__dirname, '../lancedb');
  const db = await (lancedb as any).connect(dbPath);
  // Explicit Arrow schema to avoid inference errors for productNumber
  const vectorDim = records[0].vector.length;
  const schema = new arrow.Schema([
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

  // Create or overwrite the 'products' table with explicit schema
  await db.createTable('products', records, { schema, mode: 'overwrite' });

  console.log(`Ingested ${records.length} products into LanceDB at ${dbPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}); 