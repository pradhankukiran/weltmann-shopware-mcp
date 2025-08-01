"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
require("dotenv/config");
const path_1 = __importDefault(require("path"));
const csv_parse_1 = require("csv-parse");
const openai_1 = __importDefault(require("openai"));
const lancedb = __importStar(require("@lancedb/lancedb"));
const arrow = __importStar(require("apache-arrow"));
async function main() {
    const csvPath = path_1.default.resolve(__dirname, '../data/weltmannproducts.csv');
    if (!fs_1.default.existsSync(csvPath)) {
        console.error(`CSV file not found at ${csvPath}`);
        process.exit(1);
    }
    const openai = new openai_1.default();
    const model = 'text-embedding-3-large';
    const batchSize = 50; // Reduced batch size for better memory management
    const dbPath = path_1.default.resolve(__dirname, '../lancedb');
    const db = await lancedb.connect(dbPath);
    let schema = null;
    let table = null;
    let totalProcessed = 0;
    let currentBatch = [];
    let isFirstBatch = true;
    console.log(`Starting ingestion with batch size: ${batchSize}`);
    logMemoryUsage('Initial');
    const parser = fs_1.default.createReadStream(csvPath).pipe((0, csv_parse_1.parse)({ columns: true, trim: true, bom: true }));
    for await (const row of parser) {
        currentBatch.push({
            productNumber: row.productNumber,
            productName: row.productName,
            vehicleBrand: row.vehicleBrand,
            vehicleModel: row.vehicleModel,
            vehicleVariant: row.vehicleVariant
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
function logMemoryUsage(stage) {
    const used = process.memoryUsage();
    console.log(`[${stage}] Memory usage:`, {
        rss: `${Math.round(used.rss / 1024 / 1024 * 100) / 100} MB`,
        heapUsed: `${Math.round(used.heapUsed / 1024 / 1024 * 100) / 100} MB`,
        heapTotal: `${Math.round(used.heapTotal / 1024 / 1024 * 100) / 100} MB`,
        external: `${Math.round(used.external / 1024 / 1024 * 100) / 100} MB`
    });
}
async function processBatch(batch, openai, model, db, schema, table, offset, isFirstBatch) {
    console.log(`Processing batch: rows ${offset + 1}-${offset + batch.length}`);
    const inputs = batch.map(r => `${r.productName} | ${r.vehicleBrand} | ${r.vehicleModel} | ${r.vehicleVariant}`);
    let resp;
    let retries = 3;
    while (retries > 0) {
        try {
            resp = await openai.embeddings.create({ model, input: inputs });
            break;
        }
        catch (error) {
            retries--;
            console.warn(`Embedding API error (${retries} retries left):`, error);
            if (retries === 0)
                throw error;
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
        vector: item.embedding
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
            new arrow.Field('vector', new arrow.FixedSizeList(vectorDim, new arrow.Field('item', new arrow.Float32(), false)), false),
        ]);
        const newTable = await db.createTable('products', records, { schema: newSchema, mode: 'overwrite' });
        console.log(`Created table with ${records.length} initial records`);
        return { schema: newSchema, table: newTable };
    }
    else {
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
