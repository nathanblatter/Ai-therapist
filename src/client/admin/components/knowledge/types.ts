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
  metadata: Record<string, unknown> | null;
}

/** Provenance stamped on chunks promoted from the worksheet review queue
 *  (source = 'worksheet_promotion'); null for everything else. */
export interface WorksheetPromotionProvenance {
  worksheet_instance_id: number;
  reviewer: string;
  promoted_at: string;
  template_kind: string;
}

export function promotionProvenance(c: Chunk): WorksheetPromotionProvenance | null {
  if (c.source !== 'worksheet_promotion') return null;
  const p = c.metadata?.provenance;
  if (!p || typeof p !== 'object') return null;
  const rec = p as Partial<Record<keyof WorksheetPromotionProvenance, unknown>>;
  // BIGSERIAL ids may arrive as strings from pg; accept either.
  const instanceId = Number(rec.worksheet_instance_id);
  if (!Number.isFinite(instanceId) || typeof rec.reviewer !== 'string') return null;
  return {
    worksheet_instance_id: instanceId,
    reviewer: rec.reviewer,
    promoted_at: typeof rec.promoted_at === 'string' ? rec.promoted_at : '',
    template_kind: typeof rec.template_kind === 'string' ? rec.template_kind : '',
  };
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
