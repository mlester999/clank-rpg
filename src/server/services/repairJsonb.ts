import type { Db, Queryable } from "../db/types";

/**
 * Repairs jsonb values that were stored as a jsonb STRING containing JSON text — what the old postgres.js adapter
 * produced for every json/jsonb parameter (it serialised already-serialised text a second time).
 *
 * Only a value that (a) is a jsonb string and (b) decodes to an object or array is touched, so a legitimate
 * string value can never be altered. Tables protected by an append-only trigger are reported, never modified.
 */
export interface RepairFinding {
  table: string;
  column: string;
  affected: number;
}

const LOOKS_LIKE_JSON = "'^\\s*[\\{\\[]'";

async function candidates(q: Queryable): Promise<Array<{ table: string; column: string }>> {
  const rows = await q.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name from information_schema.columns c
       join pg_tables t on t.schemaname = c.table_schema and t.tablename = c.table_name
      where c.table_schema = 'public' and c.data_type = 'jsonb'
        and not exists (select 1 from pg_trigger g where g.tgrelid = format('public.%I', c.table_name)::regclass and not g.tgisinternal and g.tgname like '%append_only%')
      order by 1, 2`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

export async function scanDoubleEncodedJsonb(q: Queryable): Promise<RepairFinding[]> {
  const out: RepairFinding[] = [];
  for (const { table, column } of await candidates(q)) {
    const [r] = await q.query<{ n: number }>(`select count(*)::int as n from public."${table}" where jsonb_typeof("${column}") = 'string' and ("${column}" #>> '{}') ~ ${LOOKS_LIKE_JSON}`);
    if (r && r.n > 0) out.push({ table, column, affected: Number(r.n) });
  }
  return out;
}

/** One transaction: either every affected column is repaired or none is. */
export async function repairDoubleEncodedJsonb(db: Db): Promise<RepairFinding[]> {
  return db.transaction(async (tx) => {
    const found = await scanDoubleEncodedJsonb(tx);
    for (const f of found) {
      await tx.query(`update public."${f.table}" set "${f.column}" = ("${f.column}" #>> '{}')::jsonb where jsonb_typeof("${f.column}") = 'string' and ("${f.column}" #>> '{}') ~ ${LOOKS_LIKE_JSON}`);
    }
    const left = await scanDoubleEncodedJsonb(tx);
    if (left.length) throw new Error(`repair incomplete, rolled back: ${left.map((l) => `${l.table}.${l.column}`).join(", ")}`);
    return found;
  });
}
