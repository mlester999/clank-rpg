/**
 * READ-ONLY health/inspection report for whichever database the app is configured to use.
 * Everything runs inside `SET TRANSACTION READ ONLY` (enforced by Postgres, not by trust) and the
 * transaction is rolled back, so this can never mutate a live database.
 *
 *   pnpm db:inspect
 */
import { run } from "./lib/context";

void run(async ({ db }) => {
  await db
    .transaction(async (tx) => {
      await tx.exec("SET TRANSACTION READ ONLY");
      const [v] = await tx.query<{ version: string }>("select version()");
      console.log(`server: ${String(v?.version).split(",")[0]}`);

      const mig = await tx.query<{ version: string; name: string | null }>("select version, name from supabase_migrations.schema_migrations order by version");
      console.log(`migrations applied (${mig.length}): ${mig.map((m) => m.version).join(", ")}`);

      const tables = await tx.query<{ tablename: string; rowsecurity: boolean }>("select tablename, rowsecurity from pg_tables where schemaname = 'public' order by 1");
      console.log(`public tables: ${tables.length}; without RLS: [${tables.filter((t) => !t.rowsecurity).map((t) => t.tablename).join(", ")}]`);
      const pol = await tx.query("select tablename, policyname from pg_policies where schemaname = 'public'");
      console.log(`RLS policies on public tables: ${pol.length}`);

      const roles = await tx.query<{ rolname: string }>("select rolname from pg_roles where rolname in ('anon','authenticated','service_role') order by 1");
      for (const r of roles) {
        const leaks = await tx.query<{ t: string }>(
          `select tablename as t from pg_tables where schemaname = 'public'
              and (has_table_privilege($1, format('public.%I', tablename), 'select') or has_table_privilege($1, format('public.%I', tablename), 'insert')
                or has_table_privilege($1, format('public.%I', tablename), 'update') or has_table_privilege($1, format('public.%I', tablename), 'delete'))`,
          [r.rolname],
        );
        console.log(`role ${r.rolname}: table privileges on public.* → ${r.rolname === "service_role" ? `${leaks.length} tables (expected: all)` : leaks.length === 0 ? "none ✔" : `LEAK on ${leaks.map((x) => x.t).join(", ")}`}`);
      }

      const counts: Array<[string, string]> = [
        ["character_classes", "enabled"], ["skills", "enabled"], ["game_settings", "true"], ["feature_flags", "true"], ["achievements", "enabled"], ["item_templates", "enabled"],
        ["seasons", "true"], ["telegram_users", "true"], ["telegram_messages", "true"], ["telegram_daily_activity", "true"], ["telegram_reactions", "true"],
        ["characters", "true"], ["character_claims", "true"], ["arena_cycles", "true"], ["arena_battles", "true"], ["currency_ledger", "true"], ["admin_audit_log", "true"],
      ];
      for (const [t, w] of counts) {
        const [r] = await tx.query<{ n: number }>(`select count(*)::int as n from public.${t} where ${w}`);
        console.log(`  ${t.padEnd(26)} ${String(r?.n).padStart(8)}`);
      }
      const [st] = await tx.query<{ paused: boolean }>("select paused from public.arena_state where id = 1");
      console.log(`arena_state row: ${st ? `present (paused=${st.paused})` : "MISSING"}`);

      // Role-based probe: can the API roles read or write anything? (SET LOCAL ROLE is rolled back.)
      for (const role of ["anon", "authenticated"]) {
        for (const sql of ["select count(*) from public.characters", "select count(*) from public.telegram_messages", "select count(*) from public.currency_ledger"]) {
          await tx.exec("SAVEPOINT probe");
          try {
            await tx.exec(`SET LOCAL ROLE ${role}`);
            await tx.query(sql);
            console.log(`  ✘ ${role} could run: ${sql}`);
          } catch (e) {
            console.log(`  ✔ ${role} denied: ${sql.slice(0, 44)} (${(e as Error).message.slice(0, 40)})`);
          }
          await tx.exec("ROLLBACK TO SAVEPOINT probe");
        }
      }
      throw new Error("__rollback__"); // never commit anything from an inspection
    })
    .catch((e: Error) => {
      if (e.message !== "__rollback__") throw e;
    });
});
