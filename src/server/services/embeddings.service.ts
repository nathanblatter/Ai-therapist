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
