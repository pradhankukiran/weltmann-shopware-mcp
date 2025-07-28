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
const fastify_1 = __importDefault(require("fastify"));
const swagger_1 = require("./plugins/swagger");
const config_1 = require("./config");
async function buildServer() {
    const config = (0, config_1.loadConfig)();
    const app = (0, fastify_1.default)({ logger: true });
    // Register plugins
    await app.register(swagger_1.registerSwagger);
    await app.register((await Promise.resolve().then(() => __importStar(require('./plugins/shopware')))).registerShopware);
    // Register routes
    await app.register((await Promise.resolve().then(() => __importStar(require('./routes/products')))).default);
    await app.register((await Promise.resolve().then(() => __importStar(require('./routes/orders')))).default);
    // LanceDB plugin (vector store)
    await app.register((await Promise.resolve().then(() => __importStar(require('./plugins/lancedb')))).registerLanceDB);
    // MCP plugin (streamable HTTP)
    await app.register((await Promise.resolve().then(() => __importStar(require('./plugins/mcp')))).registerMcp);
    // Healthcheck route
    app.get('/healthz', async () => {
        return { status: 'ok', up: true };
    });
    return { app, config };
}
async function start() {
    const { app, config } = await buildServer();
    try {
        await app.listen({ port: config.PORT, host: '0.0.0.0' });
        app.log.info(`Server listening on port ${config.PORT}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
void start();
