"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerShopware = void 0;
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const adminClient_1 = require("../shopware/adminClient");
const config_1 = require("../config");
exports.registerShopware = (0, fastify_plugin_1.default)(async (fastify) => {
    const env = (0, config_1.loadConfig)();
    const client = new adminClient_1.ShopwareAdminClient({
        baseUrl: env.SHOPWARE_API_URL,
        accessKeyId: env.SHOPWARE_ACCESS_KEY_ID,
        secretAccessKey: env.SHOPWARE_SECRET_ACCESS_KEY
    });
    fastify.decorate('shopware', client);
});
