// Text embeddings for the psychoeducation RAG knowledge base. Uses the OpenAI
// embeddings API with the same key path as the rest of the app. Kept tiny and
// dependency-free so both the ingest script and the retrieve_psychoeducation
// tool share one code path (and one model choice).
import { getOpenAIKey } from '../config/secrets.js';

// text-embedding-3-small: 1536 dims, cheap, strong retrieval quality. Must match
// the VECTOR(1536) column in migration 031 and whatever the corpus was ingested
// with — changing this requires re-embedding the whole knowledge base.
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

/** Embed a single string into a dense vector. Throws on API failure. */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = await getOpenAIKey();
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`Embeddings API error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { data?: { embedding?: number[] }[] };
  const embedding = data?.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new Error('Embeddings API returned no embedding');
  }
  return embedding;
}

// The API caps array inputs; 100 keeps request bodies small and failures cheap
// to retry while still amortizing the round-trip for the message-embedding sweep.
const BATCH_INPUT_LIMIT = 100;

/**
 * Embed many strings in one API call per 100 inputs. Result order matches the
 * input order (the API's index field is used, not response order). Throws on
 * any failed chunk — callers batch idempotently and simply retry next sweep.
 */
export async function embedTextBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_INPUT_LIMIT) {
    const chunk = texts.slice(start, start + BATCH_INPUT_LIMIT);
    const apiKey = await getOpenAIKey();
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: chunk }),
    });
    if (!res.ok) {
      throw new Error(`Embeddings API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
    if (!data?.data || data.data.length !== chunk.length) {
      throw new Error(`Embeddings API returned ${data?.data?.length ?? 0} embeddings for ${chunk.length} inputs`);
    }
    const ordered: number[][] = new Array(chunk.length);
    for (const item of data.data) {
      if (item.index == null || !item.embedding || item.embedding.length === 0) {
        throw new Error('Embeddings API returned a malformed batch item');
      }
      ordered[item.index] = item.embedding;
    }
    out.push(...ordered);
  }
  return out;
}
