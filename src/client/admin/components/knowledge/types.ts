// Shared types for the Knowledge Base admin (ai-therapist-116).

export interface Chunk {
  chunk_id: number;
  kind: string;
  topic: string | null;
  title: string | null;
  content: string;
  source: string;
  source_url: string | null;
  license: string | null;
  modality: string | null;
  active: boolean;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  created_at: string;
  updated_at: string | null;
  has_embedding: boolean;
}

export interface StatusCount {
  kind: string;
  active: number;
  pending: number;
}

export interface ChunkUsage {
  chunk_id: number;
  retrieved_count: number;
  chosen_count: number;
  last_used: string | null;
}

export const KINDS = ['psychoeducation', 'worksheet', 'technique'];

export interface ChunkFormValues {
  kind: string;
  topic: string;
  title: string;
  content: string;
  source: string;
  source_url: string;
  license: string;
  modality: string;
}

export function formValuesFromChunk(c: Chunk): ChunkFormValues {
  return {
    kind: c.kind,
    topic: c.topic ?? '',
    title: c.title ?? '',
    content: c.content,
    source: c.source,
    source_url: c.source_url ?? '',
    license: c.license ?? '',
    modality: c.modality ?? '',
  };
}

export const EMPTY_FORM: ChunkFormValues = {
  kind: 'psychoeducation',
  topic: '',
  title: '',
  content: '',
  source: '',
  source_url: '',
  license: '',
  modality: '',
};

// Re-exported from the shared formatters (src/client/shared/format) so the
// knowledge views keep their existing import path.
export { formatDate, formatDateTime } from '../../../shared/format';
