# Database index audit (FK and query-filter coverage)

Audited 2026-10-22 against the live stage schema (`ai_therapist`, read-only
`pg_constraint` + `pg_index`, 97 FK constraints, 218 indexes) cross-checked
with the `REFERENCES` clauses in `src/database/migrations/*.sql` and the
`WHERE` / `JOIN` columns used by `src/server/db/*.queries.ts` (and the two
services that run raw SQL, `workQueue.service.ts` and `sandboxSeed.ts`).

**No indexes were added in this pass.** The lists below are proposals for a
follow-up that can review cost on prod (table sizes there are what matter;
stage is small). Method: an FK counts as indexed when some btree index on the
child table has the FK columns as its leading prefix, partial or not.

## 1. Foreign keys with no covering index

33 of 97 FKs. Every one of these is scanned sequentially when the parent row
is deleted or its key updated (`ON DELETE CASCADE` / `SET NULL` / `RESTRICT`
all walk the child table), which is the cost of the participant-wipe and
retention paths (`DELETE FROM users` in `users.queries.ts`,
`DELETE FROM therapy_sessions` in `sessions.queries.ts` /
`demoCleanup.service.ts`). "Used in query" lists filters in app SQL; "cascade
only" means no app query filters on the column, the FK is the only reader.

| table.column | references | used in query | indexed? | note |
| --- | --- | --- | --- | --- |
| `work_items.org_id` | `organizations` | `workQueue.queries.ts` `listOrgWorkItems`: `WHERE org_id = $1 AND status = ANY($2)` | no | **Real gap**: the org work-queue list has no usable index (`idx_work_items_assignee_open` leads on `assignee_id`). |
| `crisis_events.thread_message_id` | `thread_messages` | `messagingRetention.queries.ts`: `DELETE FROM crisis_events WHERE thread_message_id = ANY($1)` | no | Retention pass only; also cascade on message purge. |
| `crisis_events.message_id` | `messages` | cascade only (`messages` delete) | no | `crisis_events` is small; message deletes are per session. |
| `risk_score_history.message_id` | `messages` | cascade only | no | Largest unindexed child on stage (658 rows); every message delete walks it. |
| `user_memories.session_id` | `therapy_sessions` | cascade only (reads go through `idx_user_memories_user`) | no | |
| `session_eval_pairs.session_b` | `therapy_sessions` | cascade only (`session_a` is covered by the unique key prefix) | no | |
| `eval_drift_alerts.acknowledged_by` | `users` | written only (`acknowledgeDriftAlert`) | no | cascade on user delete. |
| `adverse_event_reports.user_id` | `users` | `adverseEvents.queries.ts` scope clause `tc.client_id = adverse_event_reports.user_id` (correlated, inside an `EXISTS`) | no | Table is tiny; `session_id`, `organization_id`, `status` are indexed. |
| `protocol_deviations.session_id` | `therapy_sessions` | cascade only | no | |
| `practice_assignments.authored_by` | `users` | `LEFT JOIN users au ON au.userid = pa.authored_by` (join is on the users PK, not this column) | no | cascade on user delete. |
| `practice_assignments.cancelled_by` | `users` | written only | no | |
| `practice_assignments.reissued_from` | `practice_assignments` | cascade only | no | |
| `therapist_clients.assigned_by` | `users` | cascade only | no | |
| `client_invites.organization_id` | `organizations` | cascade only | no | |
| `client_invites.used_by` | `users` | written only (`markInviteUsed`) | no | |
| `care_notes.amends_note_id` | `care_notes` | cascade only | no | |
| `care_notes.org_id` | `organizations` | cascade only (reads go through `client_id`, `author_id`) | no | |
| `escalations.acknowledged_by` | `users` | written only | no | |
| `escalations.crisis_event_id` | `crisis_events` | cascade only | no | |
| `escalations.note_id` | `care_notes` | cascade only (`sandboxSeed.ts` writes it) | no | |
| `escalations.raised_by` | `users` | `escalations.queries.ts` list filter `e.raised_by = $n` (optional filter, combined with indexed `client_id` / `org_id` partial) | no | Low volume. |
| `escalations.resolved_by` | `users` | written only | no | |
| `escalations.session_id` | `therapy_sessions` | cascade only | no | |
| `work_items.acked_by` | `users` | written only | no | |
| `work_items.resolved_by` | `users` | written only | no | |
| `notifications.work_item_id` | `work_items` | cascade only | no | |
| `message_threads.org_id` | `organizations` | cascade only | no | |
| `thread_messages.crisis_event_id` | `crisis_events` | written (`SET crisis_event_id = NULL` by message id) | no | |
| `thread_messages.sender_id` | `users` | `messaging.queries.ts` unread counts `tm.thread_id = ... AND tm.sender_id <> $1` | no | Covered by `idx_thread_messages_thread (thread_id, message_id)`; `sender_id` is a residual filter. |
| `thread_read_state.user_id` | `users` | `WHERE trs.thread_id = ... AND trs.user_id = $1` | no (not leading) | Covered by the PK `(thread_id, user_id)` for every app query; only a bare user delete scans. |
| `sandbox_invites.created_by` | `users` | cascade only | no | |
| `sandbox_invites.org_id` | `organizations` | `WHERE batch_id = $1 AND org_id IS NOT NULL` | no | Covered by `idx_sandbox_invites_batch`. |
| `sandbox_invites.used_by` | `users` | written only | no | |

Covered FKs worth knowing about because the cover is a **partial** index (the
planner can use it only when the query repeats the predicate):

| table.column | index | predicate |
| --- | --- | --- |
| `escalations.org_id` | `idx_escalations_org_unassigned` | `assigned_to IS NULL AND status <> 'resolved'` |
| `escalations.assigned_to` | `idx_escalations_assignee_open` | `status <> 'resolved'` |
| `care_notes.author_id` | `idx_care_notes_author_drafts` | `status = 'draft'` |
| `notifications.user_id` | `idx_notifications_user_unread` | `read_at IS NULL` |
| `crisis_events.client_user_id` | `idx_crisis_events_client` | `client_user_id IS NOT NULL` |
| `data_access_log.session_id` | `idx_data_access_log_session` | `session_id IS NOT NULL` (and the column is TEXT, joined via `ts.session_id::text`) |
| `adverse_event_reports.crisis_event_id` | `idx_ae_reports_crisis_event` | `crisis_event_id IS NOT NULL` |

## 2. Non-FK filter columns without an index

| table.column | used in query | indexed? | note |
| --- | --- | --- | --- |
| `data_access_log.user_id` / `accessed_by` | `accessLog.queries.ts` `listDataAccessLog` (`COALESCE(dal.user_id, ts.user_id) = $1`, actor filter by username join), `getParticipantAccessHistory` (`WHERE COALESCE(dal.user_id, ts.user_id) = $1`) | no | Append-only audit table; the `COALESCE` defeats a plain index anyway. Grows with every transcript view; revisit when `created_at DESC` scans get slow. |
| `therapy_sessions.ended_at` | `analytics.queries.ts` (`WHERE ended_at IS NOT NULL`, duration maths) | no | Analytics aggregates scan the table regardless; `created_at`, `status`, `user_id` are indexed. Not worth an index. |
| `thread_messages.sender_id` | see above | no | Residual filter under the thread index. |

Hot columns that **are** covered (no action): `therapy_sessions.status`,
`.user_id`, `.created_at`, `.session_type`, `.crisis_*`;
`messages(session_id, created_at)`, `.role`; `users.username`, `.role`,
`.organization_id`, `.squawk_user_id`; `user_sessions.expire`;
`session_llm_usage(session_id)`, `(purpose, created_at)`;
`client_events(kind, created_at)`; `engagement_events(session_id)`.

## 3. Proposed indexes (for prod cost review, not applied)

Ordered by expected benefit. All are small btree indexes on low-cardinality
tables; the write cost is negligible, so the review is really about whether
prod sizes make the seq scans measurable at all.

```sql
-- 1. The only unindexed FK that backs a user-facing list query.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_work_items_org_status
  ON work_items (org_id, status);

-- 2. Message-delete cascades (session delete, retention, participant wipe)
--    walk these two tables per deleted message.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_risk_score_history_message
  ON risk_score_history (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_crisis_events_message
  ON crisis_events (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_crisis_events_thread_message
  ON crisis_events (thread_message_id) WHERE thread_message_id IS NOT NULL;

-- 3. Session-delete cascades.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_memories_session
  ON user_memories (session_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_escalations_session
  ON escalations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_protocol_deviations_session
  ON protocol_deviations (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_session_eval_pairs_session_b
  ON session_eval_pairs (session_b);

-- 4. User-delete cascades on care-team tables (participant wipe, 053). The
--    actor columns (acked_by, resolved_by, raised_by, cancelled_by, used_by,
--    created_by, assigned_by, authored_by, acknowledged_by, sender_id) are
--    ON DELETE SET NULL / no-action audit pointers; index them only if a
--    staff-account deletion ever shows up as slow. Not proposed now.
```

Deliberately **not** proposed: `thread_read_state.user_id` (PK covers it),
`sandbox_invites.org_id` (batch index covers it), `adverse_event_reports.user_id`
(tiny table, correlated subquery), `data_access_log` actor columns (the
`COALESCE` filter would not use them), `therapy_sessions.ended_at`.

## 4. How to re-run this audit

```sql
-- FKs whose columns are not the leading prefix of any index on the child table
WITH fk AS (
  SELECT oid, conrelid, conkey, confrelid, conname
  FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace
)
SELECT fk.conrelid::regclass AS tbl,
       (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
          FROM unnest(fk.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = fk.conrelid AND a.attnum = k.attnum) AS cols,
       fk.confrelid::regclass AS ref_tbl,
       pg_relation_size(fk.conrelid) AS bytes
FROM fk
WHERE NOT EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indrelid = fk.conrelid
    AND (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey)
ORDER BY 1, 2;
```

Run it read-only against prod (`PGSSLMODE=require`, see `docs/db.md`) before
deciding on section 3; `bytes` there is the number that matters.
