import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

/**
 * A stand-in for Supabase Realtime, for tests and for running the chat locally without a Supabase project. It speaks what the real service speaks to
 * the real `@supabase/realtime-js` client (Phoenix channels, serializer 2.0.0: frames are `[join_ref, ref, topic, event, payload]`) and to the server
 * (`POST /realtime/v1/api/broadcast`):
 *
 *   · `/realtime/v1/websocket?apikey=…&vsn=2.0.0`  — heartbeat, `phx_join` (private channels need the publishable key as the access token — the
 *     authorization the real service performs with the project's RLS policy), `phx_leave`, and broadcast delivery to every joined socket;
 *   · `POST /realtime/v1/api/broadcast` — authorised with the SERVICE key; fans each message out to the subscribers of its topic;
 *   · a CLIENT publishing over the socket is refused, exactly like a private channel without an INSERT policy (and counted).
 *
 * Fault injection for the reconnection tests: drop every socket, refuse new connections, refuse joins, delay delivery, inject a frame as if a hostile
 * peer had published it. It is NOT Supabase: it proves our client and server behave correctly against this protocol, not that a given hosted project is
 * configured correctly.
 */
export interface FakeRealtimeOptions {
  port?: number;
  /** The publishable (anon) key browsers use. */
  publishableKey?: string;
  /** The service key the server broadcasts with. */
  serviceKey?: string;
}

export interface FakeRealtime {
  readonly url: string;
  readonly port: number;
  stats: { sockets: number; joins: number; deniedJoins: number; broadcasts: number; delivered: number; clientPublishes: number; restRefused: number; connectionsRefused: number; maxSockets: number };
  /** Sockets currently open. */
  sockets(): number;
  /** Sockets currently joined to the chat topic. */
  subscribers(topic?: string): number;
  /** Closes every socket (a network failure from the client's point of view). */
  dropAll(): void;
  /** While false, new WebSocket connections are refused. */
  acceptConnections(on: boolean): void;
  /** While true, every join is answered with an error (a project whose policy denies the topic). */
  denyJoins(on: boolean): void;
  /** Delay (ms) before a broadcast is delivered to sockets. */
  setDeliveryDelay(ms: number): void;
  /** Pushes a frame to the subscribers of a topic exactly as the service would — as a hostile peer on a public channel could. */
  inject(topic: string, event: string, payload: unknown): number;
  stop(): Promise<void>;
}

const readBody = (req: IncomingMessage, max = 64 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

export async function startFakeRealtime(opts: FakeRealtimeOptions = {}): Promise<FakeRealtime> {
  const publishableKey = opts.publishableKey ?? "fake-publishable-key-0123456789";
  const serviceKey = opts.serviceKey ?? "fake-service-role-key-0123456789";
  const stats: FakeRealtime["stats"] = { sockets: 0, joins: 0, deniedJoins: 0, broadcasts: 0, delivered: 0, clientPublishes: 0, restRefused: 0, connectionsRefused: 0, maxSockets: 0 };
  /** A minimal Supabase Storage stand-in (in memory): lets the app run end to end locally with SUPABASE_URL pointing here — profile photos included. */
  const objects = new Map<string, { mime: string; bytes: Buffer }>();
  const open = new Set<WebSocket>();
  const joined = new Map<WebSocket, Set<string>>();
  let accepting = true;
  let denying = false;
  let delay = 0;

  const send = (ws: WebSocket, frame: unknown[]): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const fan = (topic: string, event: string, payload: unknown): number => {
    let n = 0;
    for (const [ws, topics] of joined) {
      if (!topics.has(topic)) continue;
      send(ws, [null, null, topic, "broadcast", { type: "broadcast", event, payload }]);
      n++;
    }
    stats.delivered += n;
    return n;
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    open.add(ws);
    stats.sockets++;
    stats.maxSockets = Math.max(stats.maxSockets, open.size);
    ws.on("close", () => {
      open.delete(ws);
      joined.delete(ws);
    });
    ws.on("error", () => undefined);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // serializer 2.0.0 sends a client's broadcast as a BINARY frame: a browser publishing to the room. Refused (no INSERT policy), never delivered.
        stats.clientPublishes++;
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!Array.isArray(frame) || frame.length !== 5) return;
      const [joinRef, ref, topic, event, payload] = frame as [string | null, string | null, string, string, Record<string, unknown>];
      if (topic === "phoenix" && event === "heartbeat") return send(ws, [null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]);
      if (event === "access_token") return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
      if (event === "phx_join") {
        const config = (payload.config ?? {}) as { private?: boolean };
        const token = payload.access_token;
        const authorised = !denying && (!config.private || token === publishableKey);
        if (!authorised) {
          stats.deniedJoins++;
          return send(ws, [joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "Unauthorized: You do not have permissions to read from this Channel topic" } }]);
        }
        stats.joins++;
        const topics = joined.get(ws) ?? new Set<string>();
        topics.add(topic);
        joined.set(ws, topics);
        return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: [] } }]);
      }
      if (event === "phx_leave") {
        joined.get(ws)?.delete(topic);
        send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
        return send(ws, [joinRef, null, topic, "phx_close", {}]);
      }
      if (event === "broadcast") {
        // a browser publishing to a private channel without an INSERT policy: refused, never delivered
        stats.clientPublishes++;
        return send(ws, [joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "Unauthorized to publish" } }]);
      }
    });
  });

  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/realtime/v1/api/broadcast") {
      const key = req.headers.apikey;
      // the bearer token is optional (a new-style secret key is not a JWT and is sent as `apikey` only); when present it must be the key
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (key !== serviceKey || (bearer !== "" && bearer !== serviceKey)) {
        stats.restRefused++;
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
        return;
      }
      try {
        const body = JSON.parse(await readBody(req)) as { messages?: Array<{ topic: string; event: string; payload: unknown; private?: boolean }> };
        for (const m of body.messages ?? []) {
          stats.broadcasts++;
          const deliver = () => fan(`realtime:${m.topic}`, m.event, m.payload);
          if (delay > 0) setTimeout(deliver, delay);
          else deliver();
        }
        res.writeHead(202, { "content-type": "application/json" }).end("{}");
      } catch {
        res.writeHead(400).end();
      }
      return;
    }
    if (url.pathname.startsWith("/storage/v1/object/")) {
      const key = req.headers.apikey;
      if (key !== serviceKey) {
        res.writeHead(401).end();
        return;
      }
      const path = url.pathname.slice("/storage/v1/object/".length);
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        objects.set(path, { mime: String(req.headers["content-type"] ?? "application/octet-stream"), bytes: Buffer.concat(chunks) });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      } else if (req.method === "GET") {
        const o = objects.get(path);
        if (!o) res.writeHead(404).end();
        else res.writeHead(200, { "content-type": o.mime, "content-length": o.bytes.length }).end(o.bytes);
      } else if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      } else res.writeHead(405).end();
      return;
    }
    // test / QA remote control (the stand-in only — nothing like this exists on Supabase)
    if (req.method === "POST" && url.pathname.startsWith("/_control/")) {
      const action = url.pathname.slice("/_control/".length);
      const on = url.searchParams.get("on") !== "0";
      if (action === "drop") for (const ws of open) ws.terminate();
      else if (action === "accept") accepting = on;
      else if (action === "deny") denying = on;
      else if (action === "delay") delay = Number(url.searchParams.get("ms") ?? 0);
      else if (action === "inject") {
        const m = JSON.parse(await readBody(req)) as { topic: string; event: string; payload: unknown };
        fan(`realtime:${m.topic}`, m.event, m.payload);
      } else {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, sockets: open.size }));
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sockets: open.size, stats }));
      return;
    }
    res.writeHead(404).end();
  });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/realtime/v1/websocket" || !accepting || url.searchParams.get("apikey") !== publishableKey) {
      stats.connectionsRefused++;
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats,
    sockets: () => open.size,
    subscribers: (topic = "realtime:arena-chat") => [...joined.values()].filter((t) => t.has(topic)).length,
    dropAll() {
      for (const ws of open) ws.terminate();
    },
    acceptConnections(on) {
      accepting = on;
    },
    denyJoins(on) {
      denying = on;
    },
    setDeliveryDelay(ms) {
      delay = ms;
    },
    inject: (topic, event, payload) => fan(topic.startsWith("realtime:") ? topic : `realtime:${topic}`, event, payload),
    async stop() {
      for (const ws of open) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
