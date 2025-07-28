"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.embed = embed;
const openai_1 = __importDefault(require("openai"));
/**
 * Compute a vector embedding for a given text using OpenAI.
 * @param text - The text to embed.
 * @returns The embedding vector.
 */
async function embed(text) {
    const openai = new openai_1.default();
    const res = await openai.embeddings.create({ model: 'text-embedding-3-large', input: text });
    return res.data[0].embedding;
}
