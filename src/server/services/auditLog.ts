import { json, type Queryable } from "../db/types";

/**
 * The admin audit log (`admin_audit_log`, append-only). Every admin mutation — and every lifecycle transition the Arena makes by itself — is recorded
 * through here, in the SAME transaction as the change it describes. It lives in its own tiny module so the Arena engine can write to it without
 * importing the whole admin service. `services/admin.ts` re-exports it, so existing call sites are unchanged.
 */
export async function audit(q: Queryable, actor: string, action: string, entityType: string, entityId: string | null, detail: unknown = {}): Promise<void> {
  await q.query(
    "insert into public.admin_audit_log (actor, action, entity_type, entity_id, detail) values ($1, $2, $3, $4, $5::jsonb)",
    [actor, action, entityType, entityId, json(detail)],
  );
}
