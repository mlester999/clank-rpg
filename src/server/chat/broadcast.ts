import { CHAT_EVENT, CHAT_TOPIC } from "@/domain/chat/limits";
import type { ChatEnvelope } from "@/domain/chat/types";

/**
 * ARENA CHAT — handing a COMMITTED event to Supabase Realtime.
 *
 * Over the Realtime REST API (`POST {project}/realtime/v1/api/broadcast`, authorised with the service-role key, private topic): one short HTTP call, no
 * socket, nothing kept open between invocations — right for a serverless function, and no database connection involved. The row is already durable
 * when this runs, so a failure here costs only the instant delivery: browsers still get the message on their next catch-up. It therefore:
 *
 *   · never throws (a Realtime outage must not fail a send that succeeded);
 *   · gives up after a short deadline (a send never waits on a slow Realtime);
 *   · opens a circuit after a few failures in a row and skips the call for a while, so an outage does not add the deadline to every send.
 */
export interface ChatBroadcaster {
  publish(envelope: ChatEnvelope): Promise<boolean>;
}

export interface RestBroadcasterOptions {
  /** The Supabase project URL, e.g. https://<ref>.supabase.co */
  url: string;
  /** The service-role (secret) key — SERVER ONLY. */
  key: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** After this many failures in a row the circuit opens … */
  failuresToOpen?: number;
  /** … and stays open this long. */
  openMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export function createRestBroadcaster(o: RestBroadcasterOptions): ChatBroadcaster {
  const endpoint = `${o.url.replace(/\/+$/, "")}/realtime/v1/api/broadcast`;
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 2_500;
  const failuresToOpen = o.failuresToOpen ?? 3;
  const openMs = o.openMs ?? 30_000;
  const log = o.log ?? ((m: string) => console.warn(`[arena-chat] ${m}`));
  let failures = 0;
  let openUntil = 0;
  return {
    async publish(envelope) {
      if (now() < openUntil) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint, {
          method: "POST",
          // The legacy service_role key is a JWT and is also sent as the bearer token; a new-style secret key (`sb_secret_…`) is not a JWT and travels in `apikey` only.
          headers: { "content-type": "application/json", apikey: o.key, ...(o.key.startsWith("eyJ") ? { authorization: `Bearer ${o.key}` } : {}) },
          body: JSON.stringify({ messages: [{ topic: CHAT_TOPIC, event: CHAT_EVENT, payload: envelope, private: true }] }),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        failures = 0;
        return true;
      } catch (error) {
        failures++;
        if (failures >= failuresToOpen) {
          openUntil = now() + openMs;
          failures = 0;
          log(`Realtime is not accepting broadcasts (${error instanceof Error ? error.message : "error"}); pausing broadcasts for ${Math.round(openMs / 1000)} s — messages are still saved and reach browsers on their next catch-up`);
        }
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A broadcaster for "Realtime is not configured": every publish is a quiet no-op. */
export const noBroadcaster: ChatBroadcaster = { publish: async () => false };
