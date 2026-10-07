import net from "node:net";

/**
 * A protocol-aware TCP proxy for tests that need to see — or break — what a shared transaction pooler would. It sits in front of a THROWAWAY
 * Postgres (CLANK_TEST_PG_URL), never a database that matters.
 *
 *  · measures PIPELINING: how many request batches (Sync / simple Query) are in flight on one connection at the same time
 *  · `mode: "pipeline-hang"` EMULATES the documented transaction-pooler limitation: a batch that arrives while another batch on the same connection
 *    is still unanswered is swallowed, so that query never answers (it hangs — it does not fail)
 *  · `mode: "drop"` EMULATES a connection that a pooler (or a frozen serverless function) has silently dropped: `drop()` stops forwarding in
 *    both directions without closing anything, so the next query on it just hangs
 */
export interface PgProxyStats {
  connectionsOpened: number;
  currentConnections: number;
  maxConnections: number;
  batches: number;
  maxInFlightOnOneConnection: number;
  pipelinedBatches: number;
  swallowedBatches: number;
}

export interface PgProxy {
  readonly port: number;
  readonly stats: PgProxyStats;
  /** Silently kill every connection that is open right now (no FIN, no RST). New connections work normally. */
  drop(): void;
  resetStats(): void;
  close(): Promise<void>;
}

export async function startPgProxy(target: { host: string; port: number }, options: { mode?: "none" | "pipeline-hang"; delayMs?: number } = {}): Promise<PgProxy> {
  const mode = options.mode ?? "none";
  const delayMs = options.delayMs ?? 0;
  const stats: PgProxyStats = { connectionsOpened: 0, currentConnections: 0, maxConnections: 0, batches: 0, maxInFlightOnOneConnection: 0, pipelinedBatches: 0, swallowedBatches: 0 };
  const sockets = new Set<net.Socket>();
  const dead = new Set<symbol>();
  const later = (fn: () => void) => (delayMs > 0 ? void setTimeout(fn, delayMs) : fn());

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    const id = Symbol("connection");
    sockets.add(client);
    sockets.add(upstream);
    stats.connectionsOpened++;
    stats.currentConnections++;
    stats.maxConnections = Math.max(stats.maxConnections, stats.currentConnections);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stats.currentConnections--;
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);

    let fbuf = Buffer.alloc(0);
    let sbuf = Buffer.alloc(0);
    let startupDone = false;
    let authReady = false;
    let inFlight = 0;
    let batchOpen = false;
    let swallowing = false;

    client.on("data", (chunk) => {
      if (dead.has(id)) return;
      fbuf = Buffer.concat([fbuf, chunk]);
      const out: Buffer[] = [];
      for (;;) {
        if (!startupDone) {
          if (fbuf.length < 4) break;
          const len = fbuf.readInt32BE(0);
          if (fbuf.length < len) break;
          const code = len >= 8 ? fbuf.readInt32BE(4) : 0;
          out.push(fbuf.subarray(0, len));
          fbuf = fbuf.subarray(len);
          if (code !== 80877103) startupDone = true; // an SSLRequest keeps us in startup
          continue;
        }
        if (fbuf.length < 5) break;
        const type = String.fromCharCode(fbuf[0] as number);
        const len = fbuf.readInt32BE(1);
        if (fbuf.length < len + 1) break;
        const message = fbuf.subarray(0, len + 1);
        fbuf = fbuf.subarray(len + 1);
        if (type === "X") {
          out.push(message);
          continue;
        }
        if (!batchOpen) {
          batchOpen = true;
          if (inFlight >= 1) {
            stats.pipelinedBatches++;
            if (mode === "pipeline-hang") {
              swallowing = true;
              stats.swallowedBatches++;
            }
          }
        }
        if (!swallowing) out.push(message);
        if (type === "S" || type === "Q") {
          batchOpen = false;
          stats.batches++;
          if (!swallowing) {
            inFlight++;
            stats.maxInFlightOnOneConnection = Math.max(stats.maxInFlightOnOneConnection, inFlight);
          }
          swallowing = false;
        }
      }
      if (out.length) {
        const data = Buffer.concat(out);
        later(() => {
          if (!closed && !dead.has(id)) upstream.write(data);
        });
      }
    });

    upstream.on("data", (chunk) => {
      if (dead.has(id)) return;
      sbuf = Buffer.concat([sbuf, chunk]);
      for (;;) {
        if (sbuf.length < 5) break;
        const len = sbuf.readInt32BE(1);
        if (sbuf.length < len + 1) break;
        if (sbuf[0] === 0x5a) {
          if (!authReady) authReady = true;
          else inFlight = Math.max(0, inFlight - 1);
        }
        sbuf = sbuf.subarray(len + 1);
      }
      later(() => {
        if (!closed && !dead.has(id)) client.write(chunk);
      });
    });

    connections.set(id, () => dead.add(id));
  });
  const connections = new Map<symbol, () => void>();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    stats,
    drop: () => {
      for (const kill of connections.values()) kill();
    },
    resetStats: () => {
      Object.assign(stats, { connectionsOpened: 0, maxConnections: stats.currentConnections, batches: 0, maxInFlightOnOneConnection: 0, pipelinedBatches: 0, swallowedBatches: 0 });
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
