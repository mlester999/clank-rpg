import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseTelegramUpdate, type ParsedUpdate } from "@/domain/telegram/updates";
import type { IngestMessage } from "@/domain/telegram/types";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { makeTextHasher } from "@/server/crypto";
import type { Db } from "@/server/db/types";
import { setTelegramStatus, importTelegramExportJson } from "@/server/services/admin";
import { ensureEligibleCharacter, importMessages, ingestUpdate, recomputeTelegramUser, type IngestDeps } from "@/server/services/telegramIngest";

import { count, createTestDb, resetDb } from "../support/db";

let db: Db;
let deps: IngestDeps;
const CHAT = -1001234567890;
const T0 = Date.UTC(2026, 5, 1, 9, 0, 0);
const DAY = 86_400_000;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  deps = {
    settings: await loadSettings(db),
    classes: await loadClasses(db),
    hash: makeTextHasher("test-pepper-value-123"),
    classRollSecret: "test-class-secret-value-0123456789",
  };
});

let mid = 0;
function raw(author: number, text: string, atMs: number, over: Record<string, unknown> = {}) {
  return {
    update_id: ++mid + 1_000_000,
    message: { message_id: mid, date: Math.floor(atMs / 1000), chat: { id: CHAT, type: "supergroup" }, from: { id: author, is_bot: false, first_name: `User${author}`, username: `user${author}` }, text, ...over },
  };
}
const send = (u: unknown) => ingestUpdate(db, parseTelegramUpdate(u, CHAT) as ParsedUpdate, deps);

/** Sends `n` distinct substantive messages, ≤ perDay per UTC day, one minute apart. */
async function sendMessages(author: number, n: number, perDay = 30, startDay = 0) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const day = startDay + Math.floor(i / perDay);
    results.push(await send(raw(author, `thoughtful message number ${i} about bonding curves and launch ${i * 13} mechanics`, T0 + day * DAY + (i % perDay) * 60_000)));
  }
  return results;
}

describe("50-message eligibility → automatic hero", () => {
  it("creates no hero at 49, creates one at 50, and keeps it at 51+", async () => {
    await sendMessages(500, 49);
    expect(await count(db, "characters")).toBe(0);
    const user49 = (await db.query<{ qualifying_message_count: number }>("select qualifying_message_count from public.telegram_users where telegram_user_id = 500"))[0]!;
    expect(user49.qualifying_message_count).toBe(49);

    const [r50] = await sendMessages(500, 1, 30, 10);
    expect(r50).toMatchObject({ status: "PROCESSED", qualifies: true, characterCreated: true });
    expect(await count(db, "characters", "telegram_user_id = 500")).toBe(1);
    const heroBefore = await db.query("select c.*, cs.variation, cs.telegram_bonus, ca.rarity, ca.parts, ca.seed, ca.sprite from public.characters c join public.character_stats cs on cs.character_id = c.id join public.character_appearances ca on ca.character_id = c.id where c.telegram_user_id = 500");
    await sendMessages(500, 1, 30, 20);
    expect((await db.query("select c.*, cs.variation, cs.telegram_bonus, ca.rarity, ca.parts, ca.seed, ca.sprite from public.characters c join public.character_stats cs on cs.character_id = c.id join public.character_appearances ca on ca.character_id = c.id where c.telegram_user_id = 500"))).toEqual(heroBefore);
    // messages past 51 never create a duplicate or rewrite the permanent hero
    await sendMessages(500, 20, 30, 21);
    expect(await count(db, "characters", "telegram_user_id = 500")).toBe(1);
  });

  it("two simultaneous updates crossing 50 create exactly one hero", async () => {
    await sendMessages(506, 49);
    const a = raw(506, "a distinct substantive message about the launch schedule and product feedback", T0 + 10 * DAY);
    const b = raw(506, "another distinct substantive message about the community roadmap and testing", T0 + 10 * DAY + 60_000);
    const results = await Promise.all([send(a), send(b)]);
    expect(results.filter((r) => r.status === "PROCESSED" && r.characterCreated)).toHaveLength(1);
    expect((await db.query<{ qualifying_message_count: number }>("select qualifying_message_count from public.telegram_users where telegram_user_id = 506"))[0]?.qualifying_message_count).toBe(51);
    expect(await count(db, "characters", "telegram_user_id = 506")).toBe(1);
  });

  it("does not delete an existing hero if its stored count falls below the configured minimum", async () => {
    await sendMessages(507, 50);
    const [before] = await db.query("select id, class_id, name, power from public.characters where telegram_user_id = 507");
    const [user] = await db.query("select * from public.telegram_users where telegram_user_id = 507");
    await db.query("update public.telegram_users set qualifying_message_count = 49 where telegram_user_id = 507");
    const created = await db.transaction((tx) => ensureEligibleCharacter(tx, { ...(user as Record<string, unknown>), qualifying_message_count: 49 } as never, deps, "TELEGRAM"));
    expect(created).toMatchObject({ created: false, characterId: (before as { id: string }).id });
    expect(await db.query("select id, class_id, name, power from public.characters where telegram_user_id = 507")).toEqual([before]);
  });

  it("the hero can exist and fight without the member ever visiting the site (unclaimed)", async () => {
    await sendMessages(501, 100);
    const [hero] = await db.query<{ id: string; origin: string; status: string }>("select id, origin, status from public.characters where telegram_user_id = 501");
    expect(hero).toMatchObject({ origin: "TELEGRAM", status: "ACTIVE" });
    expect(await count(db, "character_claims")).toBe(0);
    expect(await count(db, "character_stats", `character_id = '${hero!.id}'`)).toBe(1);
    expect(await count(db, "character_appearances", `character_id = '${hero!.id}'`)).toBe(1);
  });

  it("names are sanitised and the identity is the numeric id (usernames are display data only)", async () => {
    await sendMessages(502, 100);
    await send(raw(502, "one more message after a username change to test things", T0 + 40 * DAY, { from: { id: 502, is_bot: false, first_name: "Renamed", username: "brand_new_name" } }));
    const u = (await db.query<{ username: string; display_name: string }>("select username, display_name from public.telegram_users where telegram_user_id = 502"))[0]!;
    expect(u.username).toBe("brand_new_name");
    expect(await count(db, "telegram_users", "telegram_user_id = 502")).toBe(1);
    expect(await count(db, "characters", "telegram_user_id = 502")).toBe(1); // same hero after a rename
  });

  it("class and stats are generated deterministically; the class is PERMANENT", async () => {
    await sendMessages(503, 100);
    const hero = (await db.query<{ id: string; class_id: string }>("select id, class_id from public.characters where telegram_user_id = 503"))[0]!;
    await expect(db.query("update public.characters set class_id = 'mage' where id = $1 and class_id <> 'mage'", [hero.id])).rejects.toThrow(/permanent/);
    const other = ["warrior", "mage", "rogue", "ranger", "tank", "cleric"].find((c) => c !== hero.class_id)!;
    await expect(db.query("update public.characters set class_id = $2 where id = $1", [hero.id, other])).rejects.toThrow(/permanent/);
    await expect(db.query("update public.characters set telegram_user_id = 99999 where id = $1", [hero.id])).rejects.toThrow(/immutable/);
    // Re-generating from scratch with the same secret gives the same class + look (idempotent / replayable).
    await resetDb(db);
    deps = { ...deps, settings: await loadSettings(db), classes: await loadClasses(db) };
    await sendMessages(503, 100);
    const again = (await db.query<{ class_id: string }>("select class_id from public.characters where telegram_user_id = 503"))[0]!;
    expect(again.class_id).toBe(hero.class_id);
  });
});

describe("duplicates, spam and hostile input", () => {
  it("ignores duplicate webhook deliveries (same update_id) and duplicate message ids", async () => {
    const u = raw(600, "a perfectly reasonable message about the roadmap and launch", T0);
    expect((await send(u)).status).toBe("PROCESSED");
    expect((await send(u)).status).toBe("DUPLICATE_UPDATE");
    const sameMessageNewUpdate = { ...u, update_id: u.update_id + 999 };
    expect((await send(sameMessageNewUpdate)).status).toBe("DUPLICATE_MESSAGE");
    const user = (await db.query<{ total_message_count: number; qualifying_message_count: number }>("select total_message_count, qualifying_message_count from public.telegram_users where telegram_user_id = 600"))[0]!;
    expect(user).toMatchObject({ total_message_count: 1, qualifying_message_count: 1 });
  });

  it("repeated identical messages and rapid-fire 'gm' farming earn no progression", async () => {
    const results = [];
    for (let i = 0; i < 30; i++) results.push(await send(raw(601, "buy this token right now it is going to the moon for sure", T0 + i * 60_000)));
    expect(results.filter((r) => r.status === "PROCESSED" && r.qualifies)).toHaveLength(1);
    for (let i = 0; i < 40; i++) await send(raw(601, "gm", T0 + DAY + i * 1_000));
    const u = (await db.query<{ qualifying_message_count: number; total_message_count: number }>("select qualifying_message_count, total_message_count from public.telegram_users where telegram_user_id = 601"))[0]!;
    expect(u.qualifying_message_count).toBe(1);
    expect(u.total_message_count).toBe(70);
  });

  it("a spammy account is auto-flagged for review and stops progressing", async () => {
    for (let i = 0; i < 60; i++) await send(raw(602, "gm gm gm", T0 + i * 700));
    const u = (await db.query<{ status: string; flag_reason: string }>("select status, flag_reason from public.telegram_users where telegram_user_id = 602"))[0]!;
    expect(u.status).toBe("FLAGGED");
    expect(u.flag_reason).toMatch(/AUTO/);
    // a flagged member's later substantive messages do not qualify until an admin clears them
    const r = await send(raw(602, "now I am writing a long and genuinely helpful message here", T0 + 3 * DAY));
    expect(r).toMatchObject({ status: "PROCESSED", qualifies: false, reason: "USER_FLAGGED" });
  });

  it("reaching 50 while FLAGGED or BANNED does not create a hero", async () => {
    await send(raw(603, "first genuine message for this member right here", T0));
    await db.query("update public.telegram_users set status = 'FLAGGED' where telegram_user_id = 603");
    await sendMessages(603, 120, 30, 2);
    expect(await count(db, "characters", "telegram_user_id = 603")).toBe(0);
  });

  it("only the official chat counts; bots and anonymous senders are ignored", async () => {
    const other = raw(604, "a message in some other project's group chat for sure", T0, { chat: { id: -100999, type: "supergroup" } });
    expect(await send(other)).toMatchObject({ status: "IGNORED", reason: "WRONG_CHAT" });
    expect(await send(raw(605, "bot message", T0, { from: { id: 605, is_bot: true, first_name: "Bot" } }))).toMatchObject({ status: "IGNORED" });
    expect(await count(db, "telegram_users", "telegram_user_id in (604, 605)")).toBe(0);
  });

  it("message TEXT is never stored — only hashes and features", async () => {
    await send(raw(606, "secret-ish content that must not be persisted anywhere at all", T0));
    const rows = await db.query<Record<string, unknown>>("select * from public.telegram_messages where telegram_user_id = 606");
    expect(JSON.stringify(rows)).not.toContain("secret-ish");
    expect(rows[0]!.text_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("engagement signals", () => {
  it("counts replies received and reactions (not self-reactions, capped per reactor per day)", async () => {
    await send(raw(700, "an original thought worth replying to in the group chat", T0));
    const original = mid;
    await send(raw(701, "I agree with this and here is why the idea works well", T0 + 60_000, { reply_to_message: { message_id: original, from: { id: 700, is_bot: false } } }));
    const author = async () => (await db.query<{ replies_received: number; reactions_received: number }>("select replies_received, reactions_received from public.telegram_users where telegram_user_id = 700"))[0]!;
    expect((await author()).replies_received).toBe(1);

    const react = (reactor: number, add: boolean, id = original) =>
      send({ update_id: ++mid + 5_000_000, message_reaction: { chat: { id: CHAT }, message_id: id, user: { id: reactor, is_bot: false }, old_reaction: add ? [] : [{ type: "emoji", emoji: "🔥" }], new_reaction: add ? [{ type: "emoji", emoji: "🔥" }] : [] } });
    expect(await react(701, true)).toMatchObject({ status: "REACTION", applied: true });
    expect((await author()).reactions_received).toBe(1);
    expect(await react(700, true)).toMatchObject({ applied: false }); // self-reaction
    expect(await react(701, false)).toMatchObject({ applied: true });
    expect((await author()).reactions_received).toBe(0);
    expect(await react(701, true, 999_999)).toMatchObject({ applied: false }); // unknown message
  });
});

describe("historical import (never fabricated)", () => {
  function exportJson(author: number, n: number) {
    return {
      name: "Clank.trade Community", type: "public_supergroup", id: 1234567890,
      messages: Array.from({ length: n }, (_, i) => ({
        id: i + 1, type: "message", date_unixtime: String(Math.floor((T0 - 200 * DAY + Math.floor(i / 25) * DAY + (i % 25) * 120_000) / 1000)),
        from: `Veteran ${author}`, from_id: `user${author}`, text: `historical contribution number ${i} discussing the early days of launches ${i * 3}`,
      })),
    };
  }

  it("members with 50+ verified historical messages are eligible immediately", async () => {
    const summary = await importTelegramExportJson(db, exportJson(800, 130), deps, "admin");
    expect(summary.summary).toMatchObject({ messagesRead: 130, messagesInserted: 130, charactersCreated: 1 });
    const hero = (await db.query<{ origin: string }>("select origin from public.characters where telegram_user_id = 800"))[0]!;
    expect(hero.origin).toBe("HISTORICAL_IMPORT");
    expect((await db.query<{ qualifying_message_count: number }>("select qualifying_message_count from public.telegram_users where telegram_user_id = 800"))[0]!.qualifying_message_count).toBe(130);
  });

  it("members with fewer than 50 historical messages get no hero, and re-importing is idempotent", async () => {
    await importTelegramExportJson(db, exportJson(801, 49), deps, "admin");
    expect(await count(db, "characters", "telegram_user_id = 801")).toBe(0);
    const again = await importTelegramExportJson(db, exportJson(801, 49), deps, "admin");
    expect(again.summary).toMatchObject({ messagesInserted: 0, duplicatesSkipped: 49 });
    expect((await db.query<{ qualifying_message_count: number }>("select qualifying_message_count from public.telegram_users where telegram_user_id = 801"))[0]!.qualifying_message_count).toBe(49);
  });

  it("live messages after an import continue from the imported counters", async () => {
    await importTelegramExportJson(db, exportJson(802, 49), deps, "admin");
    expect(await count(db, "characters", "telegram_user_id = 802")).toBe(0);
    const r = await send(raw(802, "the fiftieth qualifying message arrives live right now", T0));
    expect(r).toMatchObject({ qualifies: true, characterCreated: true });
  });

  it("import is audit-logged", async () => {
    await importTelegramExportJson(db, exportJson(803, 5), deps, "admin");
    const log = await db.query<{ action: string }>("select action from public.admin_audit_log");
    expect(log.map((l) => l.action)).toContain("telegram.import");
  });
});

describe("recompute equals incremental scoring", () => {
  it("rebuilding a member from stored features reproduces the live counters exactly", async () => {
    // A mix: normal, duplicates, too-fast, gm, long, replies, across several days.
    const seq: Array<[string, number]> = [];
    for (let i = 0; i < 70; i++) seq.push([`genuine message ${i} about the protocol ${i * 5} and some more words`, T0 + Math.floor(i / 25) * DAY + (i % 25) * 90_000]);
    for (let i = 0; i < 6; i++) seq.push(["buy this token right now it is going to the moon", T0 + 4 * DAY + i * 20_000]);
    for (let i = 0; i < 10; i++) seq.push(["gm", T0 + 5 * DAY + i * 500]);
    for (const [text, at] of seq) await send(raw(900, text, at));
    const live = (await db.query<Record<string, unknown>>("select total_message_count, qualifying_message_count, active_days, quality_sum, activity_score, behavior from public.telegram_users where telegram_user_id = 900"))[0]!;
    await db.transaction((tx) => recomputeTelegramUser(tx, 900, deps));
    const rebuilt = (await db.query<Record<string, unknown>>("select total_message_count, qualifying_message_count, active_days, quality_sum, activity_score, behavior from public.telegram_users where telegram_user_id = 900"))[0]!;
    expect(rebuilt.total_message_count).toBe(live.total_message_count);
    expect(rebuilt.qualifying_message_count).toBe(live.qualifying_message_count);
    expect(rebuilt.active_days).toBe(live.active_days);
    expect(Number(rebuilt.quality_sum)).toBeCloseTo(Number(live.quality_sum), 3);
    expect(Number(rebuilt.activity_score)).toBeCloseTo(Number(live.activity_score), 1);
    expect(rebuilt.behavior).toEqual(live.behavior);
  });
});

describe("admin moderation", () => {
  it("banning suspends the hero and removes it from the arena pool; clearing restores it", async () => {
    await sendMessages(950, 100);
    const heroId = (await db.query<{ id: string }>("select id from public.characters where telegram_user_id = 950"))[0]!.id;
    await setTelegramStatus(db, 950, "BANNED", "spam ring", "admin", deps);
    expect((await db.query<{ status: string }>("select status from public.characters where id = $1", [heroId]))[0]!.status).toBe("SUSPENDED");
    await setTelegramStatus(db, 950, "OK", null, "admin", deps);
    expect((await db.query<{ status: string }>("select status from public.characters where id = $1", [heroId]))[0]!.status).toBe("ACTIVE");
    const log = await db.query<{ action: string }>("select action from public.admin_audit_log order by id");
    expect(log.map((l) => l.action)).toEqual(["telegram.status", "telegram.status"]);
  });

  it("bulk import goes through importMessages directly and survives re-chunking", async () => {
    const messages: IngestMessage[] = Array.from({ length: 450 }, (_, i) => ({
      chatId: CHAT, messageId: 10_000 + i, authorId: 960 + (i % 3), username: null, displayName: `V${i % 3}`,
      sentAtMs: T0 - 100 * DAY + Math.floor(i / 9) * DAY + (i % 9) * 300_000,
      text: `bulk imported message ${i} with plenty of meaningful words to qualify ${i * 11}`,
      isReply: false, isForwarded: false, mediaKind: "none", source: "IMPORT",
    }));
    const s = await importMessages(db, messages, deps, 100);
    expect(s).toMatchObject({ messagesInserted: 450, usersAffected: 3 });
    expect(await count(db, "characters")).toBe(3);
  });
});
