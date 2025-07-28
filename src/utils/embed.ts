import OpenAI from 'openai';

/**
 * Compute a vector embedding for a given text using OpenAI.
 * @param text - The text to embed.
 * @returns The embedding vector.
 */
export async function embed(text: string): Promise<number[]> {
  const openai = new OpenAI();
  const res = await openai.embeddings.create({ model: 'text-embedding-3-large', input: text });
  return res.data[0].embedding as number[];
} 