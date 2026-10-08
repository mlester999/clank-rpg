/**
 * A local stand-in for Supabase Realtime (+ a minimal Storage), so the Arena Chat can be tried end to end WITHOUT a Supabase project:
 *
 *   pnpm exec tsx scripts/dev-realtime.ts [--port 54380]
 *
 * It speaks what the real service speaks to the real `@supabase/realtime-js` client (private channel join, broadcast delivery, heartbeat) and to the
 * server (`POST /realtime/v1/api/broadcast`). Point the app at it with
 *
 *   SUPABASE_URL=http://127.0.0.1:54380  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54380
 *   SUPABASE_SERVICE_ROLE_KEY=dev-service-role-key-0123456789  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=dev-publishable-key-0123456789
 *
 * It is NOT Supabase: it proves the chat works against the protocol, not that a hosted project is configured correctly (docs/ARENA_CHAT.md).
 * Nothing leaves your machine, and it must never be used with a production database.
 */
import { startFakeRealtime } from "../tests/support/fakeRealtime";

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 54380;

const rt = await startFakeRealtime({ port, publishableKey: "dev-publishable-key-0123456789", serviceKey: "dev-service-role-key-0123456789" });
console.log(`Realtime stand-in listening on ${rt.url}  (publishable key: dev-publishable-key-0123456789 · service key: dev-service-role-key-0123456789)`);
const stop = async () => {
  await rt.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
