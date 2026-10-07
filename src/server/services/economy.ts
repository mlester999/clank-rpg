import type { Queryable } from "../db/types";

export interface LedgerEntryInput {
  characterId: string;
  /** Positive = credit, negative = debit. Never 0. */
  amount: number;
  reason: string;
  refType?: string;
  refId?: string;
  /** Uniqueness is enforced by the database: replaying the same key is a no-op. */
  idempotencyKey: string;
}

export interface LedgerResult {
  applied: boolean;
  balance: number;
}

/**
 * The ONLY way Clank Gold changes. Every mutation is an append-only ledger row; balances are
 * maintained by database triggers, so there is no code path that edits a balance directly.
 * Idempotent: a replayed `idempotencyKey` (retry, double-click, replayed request) does nothing.
 */
export async function applyLedger(q: Queryable, e: LedgerEntryInput): Promise<LedgerResult> {
  if (!Number.isInteger(e.amount) || e.amount === 0) throw new RangeError("ledger amount must be a non-zero integer");
  const inserted = await q.query<{ balance_after: number }>(
    `insert into public.currency_ledger (character_id, delta, reason, ref_type, ref_id, idempotency_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (idempotency_key) do nothing
     returning balance_after`,
    [e.characterId, e.amount, e.reason, e.refType ?? null, e.refId ?? null, e.idempotencyKey],
  );
  if (inserted[0]) return { applied: true, balance: Number(inserted[0].balance_after) };
  return { applied: false, balance: await getBalance(q, e.characterId) };
}

export async function getBalance(q: Queryable, characterId: string): Promise<number> {
  const rows = await q.query<{ balance: number }>("select balance from public.currency_accounts where character_id = $1", [characterId]);
  return Number(rows[0]?.balance ?? 0);
}

export interface LedgerAuditRow {
  character_id: string;
  balance: number;
  ledger_sum: number;
}

/** Any row returned is an integrity violation (balance ≠ Σ ledger). Should always be empty. */
export async function auditLedger(q: Queryable): Promise<LedgerAuditRow[]> {
  return q.query<LedgerAuditRow>("select character_id, balance, ledger_sum from public.audit_currency_ledger()");
}
