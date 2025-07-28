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
    // Read all CSV rows into memory
    const rawRows = [];
    const parser = fs_1.default.createReadStream(csvPath).pipe((0, csv_parse_1.parse)({ columns: true, trim: true, bom: true }));
    for await (const row of parser) {
        rawRows.push({
            productNumber: row.productNumber,
            productName: row.productName,
            vehicleBrand: row.vehicleBrand,
            vehicleModel: row.vehicleModel,
            vehicleVariant: row.vehicleVariant
        });
    }
    const openai = new openai_1.default();
    const records = [];
    const model = 'text-embedding-3-large';
    const batchSize = 100;
    // Batch embedding requests to speed up ingestion
    for (let i = 0; i < rawRows.length; i += batchSize) {
        const batch = rawRows.slice(i, i + batchSize);
        const inputs = batch.map(r => `${r.productName} | ${r.vehicleBrand} | ${r.vehicleModel} | ${r.vehicleVariant}`);
        const resp = await openai.embeddings.create({ model, input: inputs });
        resp.data.forEach((item, idx) => {
            records.push({
                productNumber: batch[idx].productNumber,
                productName: batch[idx].productName,
                vehicleBrand: batch[idx].vehicleBrand,
                vehicleModel: batch[idx].vehicleModel,
                vehicleVariant: batch[idx].vehicleVariant,
                vector: item.embedding
            });
        });
        console.log(`Processed embeddings for rows ${i + 1}-${Math.min(i + batchSize, rawRows.length)}`);
    }
    // Connect to LanceDB store (creates ./lancedb if missing)
    const dbPath = path_1.default.resolve(__dirname, '../lancedb');
    const db = await lancedb.connect(dbPath);
    // Explicit Arrow schema to avoid inference errors for productNumber
    const vectorDim = records[0].vector.length;
    const schema = new arrow.Schema([
        new arrow.Field('productNumber', new arrow.Utf8(), false),
        new arrow.Field('productName', new arrow.Utf8(), false),
        new arrow.Field('vehicleBrand', new arrow.Utf8(), false),
        new arrow.Field('vehicleModel', new arrow.Utf8(), false),
        new arrow.Field('vehicleVariant', new arrow.Utf8(), false),
        new arrow.Field('vector', new arrow.FixedSizeList(vectorDim, new arrow.Field('item', new arrow.Float32(), false)), false),
    ]);
    // Create or overwrite the 'products' table with explicit schema
    await db.createTable('products', records, { schema, mode: 'overwrite' });
    console.log(`Ingested ${records.length} products into LanceDB at ${dbPath}`);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
