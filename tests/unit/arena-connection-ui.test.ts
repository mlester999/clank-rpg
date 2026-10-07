import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArenaHeader } from "@/components/arena/StageHud";
import { stageCopy, stageMode } from "@/components/arena/stageMode";
import { friendly, isTransient } from "@/lib/api";

/** What a viewer sees while the connection is not "live": a clear RECONNECTING / SYNCING marker, never a bare skeleton — and never the database's own words. */
const header = (props: { online: boolean; connection?: "live" | "syncing" | "reconnecting" }) =>
  renderToStaticMarkup(createElement(ArenaHeader, { status: { label: "Live", tone: "live" }, season: null, phase: "LIVE", demo: false, ...props }));

describe("the Arena header while the connection is degraded", () => {
  it("live: no marker", () => {
    const html = header({ online: true, connection: "live" });
    expect(html).not.toMatch(/arena-syncing|arena-reconnecting/);
  });
  it("syncing (a fresh look is in flight after Back / visibility restore): 'Syncing…', and the live chip stays", () => {
    const html = header({ online: true, connection: "syncing" });
    expect(html).toMatch(/data-testid="arena-syncing"[^>]*>Syncing…/);
    expect(html).toMatch(/arena-status-chip/);
    expect(html).not.toMatch(/arena-reconnecting/);
  });
  it("reconnecting (the last request failed): 'Reconnecting…'", () => {
    const html = header({ online: false, connection: "reconnecting" });
    expect(html).toMatch(/data-testid="arena-reconnecting"[^>]*>Reconnecting…/);
    expect(html).not.toMatch(/arena-syncing/);
  });
});

describe("the stage while the server cannot be reached", () => {
  it("no state yet and the first request failed: RECONNECTING with a calm message — not an endless LOADING", () => {
    expect(stageMode({ state: null, loaded: false, online: true })).toBe("LOADING"); // only until the first request settles (≤ 8 s: the request has a deadline)
    expect(stageMode({ state: null, loaded: true, online: false })).toBe("RECONNECTING");
    expect(stageCopy("RECONNECTING", null).lines.join(" ")).toMatch(/Trying again automatically/);
  });
});

describe("transient failures speak plainly (api() codes)", () => {
  it("timeouts, network failures and 503s are 'try again' states; the wording never mentions the database, the pooler or an error code", () => {
    for (const code of ["NETWORK", "TIMEOUT", "DB_UNAVAILABLE", "ARENA_UNAVAILABLE", "REPLAY_UNAVAILABLE"]) {
      expect(isTransient(code), code).toBe(true);
      expect(friendly(code), code).toMatch(/try again|check your connection/i);
      expect(friendly(code), code).not.toMatch(/database|pooler|postgres|supabase|CONNECTION_|ECONN/);
    }
    for (const code of ["UNAUTHENTICATED", "RATE_LIMITED", "BAD_ORIGIN", "NOT_FOUND"]) expect(isTransient(code), code).toBe(false);
  });
});
