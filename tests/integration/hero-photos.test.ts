import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { renameHero } from "@/server/services/admin";
import { getHeroDetail, searchHeroes as adminSearch } from "@/server/services/heroAdmin";
import { getHeroPhotoAdminView, loadPhotoBytes, removeAdminPhoto, resolvePhoto, setAdminPhoto } from "@/server/services/heroPhotos";
import { getLeaderboard } from "@/server/services/leaderboard";
import { createBotApiPhotoSource, errorBackoffMs, pickPhotoSize, RECHECK_AFTER_MS, syncTelegramPhoto, syncTelegramPhotoBatch, TelegramPhotoError, type TelegramPhotoSource } from "@/server/services/telegramPhotos";
import { createMemoryAvatarStore } from "@/server/storage/avatarStore";
import { advanceArena } from "@/server/services/arena";
import { getArenaState, getCharacterDto, searchHeroes } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { EXE_HEADER, GIF_FILE, HTML_DOCUMENT, makeJpeg, makePng, makeWebp, SVG_WITH_SCRIPT } from "../support/images";

let db: Db;
let store: ReturnType<typeof createMemoryAvatarStore>;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  store = createMemoryAvatarStore();
});

const hero = async (): Promise<{ id: string; tg: number }> => {
  const [id] = await seedHeroes(db, 1);
  const [r] = await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [id]);
  return { id: id!, tg: Number(r!.telegram_user_id) };
};
const upload = (characterId: string, bytes: Buffer, declaredMime: string | null = null) => setAdminPhoto(db, store, { characterId, bytes, declaredMime, actor: "admin" });
const count = async (table: string) => Number((await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`))[0]!.n);

/** A faithful stand-in for the Telegram Bot API surface this feature uses. */
function fakeTelegram(photos: Record<number, { uniqueId: string; bytes: Buffer } | null>) {
  const calls = { current: 0, download: 0 };
  const failures: Array<Error | undefined> = [];
  const source: TelegramPhotoSource = {
    async currentPhoto(userId) {
      calls.current++;
      const f = failures.shift();
      if (f) throw f;
      const p = photos[userId];
      return p ? { fileId: `file-${p.uniqueId}`, fileUniqueId: p.uniqueId, width: 320, height: 320 } : null;
    },
    async download(fileId) {
      calls.download++;
      const hit = Object.values(photos).find((p) => p && `file-${p.uniqueId}` === fileId);
      if (!hit) throw new TelegramPhotoError("no such file", "API");
      return { bytes: new Uint8Array(hit.bytes) };
    },
  };
  return { source, calls, failNext: (e: Error) => failures.push(e) };
}

describe("admin profile photo — upload, replace, remove", () => {
  it("stores a validated image under a server-generated path and makes it the hero's photo", async () => {
    const { id } = await hero();
    const png = makePng(256, 256);
    const r = await upload(id, png, "image/png");
    expect(r).toMatchObject({ changed: true, source: "ADMIN", width: 256, height: 256, bytes: png.length });
    expect(r.url).toMatch(new RegExp(`^/api/avatars/${id}\\?v=[0-9a-f]{12}$`));

    const [row] = await db.query<{ storage_path: string; mime_type: string; sha256: string; updated_by: string }>("select storage_path, mime_type, sha256, updated_by from public.hero_photo_overrides where character_id = $1", [id]);
    expect(row!.storage_path).toMatch(new RegExp(`^override/${id}/[0-9a-f]{16}\\.png$`)); // never a client-supplied name
    expect(row).toMatchObject({ mime_type: "image/png", updated_by: "admin" });
    expect(store.files.get(row!.storage_path)).toEqual(new Uint8Array(png));
    expect(await resolvePhoto(db, id)).toMatchObject({ source: "ADMIN", mime: "image/png" });
    expect((await loadPhotoBytes(db, store, id))!.bytes).toEqual(new Uint8Array(png));
    expect(await count("admin_audit_log")).toBe(1);
    expect((await db.query<{ action: string }>("select action from public.admin_audit_log"))[0]!.action).toBe("hero.photo.set");
  });

  it("accepts JPEG and WebP too", async () => {
    const a = await hero();
    expect((await upload(a.id, makeJpeg(300, 300))).changed).toBe(true);
    expect((await resolvePhoto(db, a.id))!.mime).toBe("image/jpeg");
    expect((await upload(a.id, makeWebp(300, 300))).changed).toBe(true);
    expect((await resolvePhoto(db, a.id))!.mime).toBe("image/webp");
  });

  it("replacement swaps the image, changes the URL version and deletes the old object", async () => {
    const { id } = await hero();
    const first = await upload(id, makePng(128, 128, 1));
    const oldPath = (await db.query<{ storage_path: string }>("select storage_path from public.hero_photo_overrides where character_id = $1", [id]))[0]!.storage_path;
    const second = await upload(id, makePng(128, 128, 2));
    expect(second.changed).toBe(true);
    expect(second.url).not.toBe(first.url);
    expect(await count("hero_photo_overrides")).toBe(1);
    expect(store.files.has(oldPath)).toBe(false);
    expect(store.files.size).toBe(1);
  });

  it("re-uploading identical bytes is a no-op (no new object, no audit noise)", async () => {
    const { id } = await hero();
    const png = makePng(128, 128, 3);
    await upload(id, png);
    const again = await upload(id, png);
    expect(again.changed).toBe(false);
    expect(store.files.size).toBe(1);
    expect(await count("admin_audit_log")).toBe(1);
  });

  it("removal deletes the override and its object; the hero falls back to the default", async () => {
    const { id } = await hero();
    await upload(id, makePng());
    expect(await removeAdminPhoto(db, store, id, "admin")).toEqual({ removed: true });
    expect(await count("hero_photo_overrides")).toBe(0);
    expect(store.files.size).toBe(0);
    expect(await resolvePhoto(db, id)).toBeNull();
    expect(await removeAdminPhoto(db, store, id, "admin")).toEqual({ removed: false });
    expect((await db.query<{ action: string }>("select action from public.admin_audit_log order by id")).map((r) => r.action)).toEqual(["hero.photo.set", "hero.photo.remove"]);
  });

  it("rejects an unknown hero without storing anything", async () => {
    await expect(upload("00000000-0000-4000-8000-000000000000", makePng())).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(store.files.size).toBe(0);
  });
});

describe("admin profile photo — invalid uploads are rejected and leave no trace", () => {
  const rejected: Array<[string, Buffer, string | null, string]> = [
    ["an SVG with a script", SVG_WITH_SCRIPT, "image/svg+xml", "PHOTO_UNSUPPORTED_TYPE"],
    ["an HTML page labelled as PNG", HTML_DOCUMENT, "image/png", "PHOTO_UNSUPPORTED_TYPE"],
    ["an executable labelled as JPEG", EXE_HEADER, "image/jpeg", "PHOTO_UNSUPPORTED_TYPE"],
    ["a GIF", GIF_FILE, "image/gif", "PHOTO_UNSUPPORTED_TYPE"],
    ["a PNG that claims to be JPEG", makePng(), "image/jpeg", "PHOTO_MIME_MISMATCH"],
    ["a truncated PNG", makePng().subarray(0, 60), null, "PHOTO_CORRUPT"],
    ["a PNG with a script appended", Buffer.concat([makePng(), HTML_DOCUMENT]), "image/png", "PHOTO_CORRUPT"],
    ["an empty body", Buffer.alloc(0), null, "PHOTO_EMPTY"],
    ["a tiny image", makePng(16, 16), null, "PHOTO_TOO_SMALL"],
    ["an animated WebP", makeWebp(128, 128, { animated: true }), null, "PHOTO_ANIMATED"],
    ["an oversized file", Buffer.concat([makePng(), Buffer.alloc(3 * 1024 * 1024)]), null, "PHOTO_TOO_LARGE"],
  ];
  it.each(rejected)("%s", async (_name, bytes, mime, code) => {
    const { id } = await hero();
    await expect(upload(id, bytes, mime)).rejects.toMatchObject({ code });
    expect(store.files.size).toBe(0);
    expect(await count("hero_photo_overrides")).toBe(0);
    expect(await count("admin_audit_log")).toBe(0);
  });

  it("a rejected replacement keeps the existing photo untouched", async () => {
    const { id } = await hero();
    await upload(id, makePng(128, 128, 5));
    await expect(upload(id, HTML_DOCUMENT, "image/png")).rejects.toMatchObject({ code: "PHOTO_UNSUPPORTED_TYPE" });
    expect(store.files.size).toBe(1);
    expect((await resolvePhoto(db, id))!.source).toBe("ADMIN");
  });
});

describe("Telegram profile photo — cache, fallback and priority", () => {
  it("fetches by the immutable Telegram id, stores it, and shows it when there is no override", async () => {
    const { id, tg } = await hero();
    const tgPhoto = makeJpeg(320, 320, 2);
    const t = fakeTelegram({ [tg]: { uniqueId: "AQAD-1", bytes: tgPhoto } });
    expect((await syncTelegramPhoto(db, store, t.source, tg)).status).toBe("UPDATED");
    expect(await resolvePhoto(db, id)).toMatchObject({ source: "TELEGRAM", mime: "image/jpeg" });
    const [row] = await db.query<{ storage_path: string; file_unique_id: string; status: string }>("select storage_path, file_unique_id, status from public.telegram_user_photos where telegram_user_id = $1", [tg]);
    expect(row).toMatchObject({ status: "AVAILABLE", file_unique_id: "AQAD-1" });
    expect(row!.storage_path).toMatch(new RegExp(`^telegram/${tg}/[0-9a-f]{16}\\.jpg$`));
    expect((await loadPhotoBytes(db, store, id))!.bytes).toEqual(new Uint8Array(tgPhoto));
  });

  it("does not ask Telegram again within the recheck window, and never re-downloads an unchanged picture", async () => {
    const { tg } = await hero();
    const t = fakeTelegram({ [tg]: { uniqueId: "same", bytes: makeJpeg(320, 320) } });
    const clock = new FakeClock();
    expect((await syncTelegramPhoto(db, store, t.source, tg, { now: clock.now })).status).toBe("UPDATED");
    clock.advance(RECHECK_AFTER_MS - 1000);
    expect((await syncTelegramPhoto(db, store, t.source, tg, { now: clock.now })).status).toBe("SKIPPED_RECENT");
    expect(t.calls).toEqual({ current: 1, download: 1 });
    clock.advance(2000);
    expect((await syncTelegramPhoto(db, store, t.source, tg, { now: clock.now })).status).toBe("UNCHANGED"); // asked, but same file_unique_id
    expect(t.calls).toEqual({ current: 2, download: 1 }); // …so no second download
  });

  it("downloads again when the member changes their picture, and removes the superseded object", async () => {
    const { id, tg } = await hero();
    const photos: Record<number, { uniqueId: string; bytes: Buffer } | null> = { [tg]: { uniqueId: "v1", bytes: makeJpeg(320, 320, 2) } };
    const t = fakeTelegram(photos);
    await syncTelegramPhoto(db, store, t.source, tg);
    const v1 = (await resolvePhoto(db, id))!;
    photos[tg] = { uniqueId: "v2", bytes: makeJpeg(320, 320, 4) };
    expect((await syncTelegramPhoto(db, store, t.source, tg, { force: true })).status).toBe("UPDATED");
    const v2 = (await resolvePhoto(db, id))!;
    expect(v2.version).not.toBe(v1.version);
    expect(store.files.has(v1.storagePath)).toBe(false);
    expect(store.files.size).toBe(1);
  });

  it("when the member has no (visible) photo, nothing is shown and nothing is fabricated", async () => {
    const { id, tg } = await hero();
    const t = fakeTelegram({ [tg]: null });
    expect((await syncTelegramPhoto(db, store, t.source, tg)).status).toBe("NONE");
    expect(await resolvePhoto(db, id)).toBeNull();
    expect((await getHeroPhotoAdminView(db, id)).active).toBe("DEFAULT");
    expect(store.files.size).toBe(0);
  });

  it("when the member removes their photo later, the cached copy stops showing", async () => {
    const { id, tg } = await hero();
    const photos: Record<number, { uniqueId: string; bytes: Buffer } | null> = { [tg]: { uniqueId: "a", bytes: makeJpeg(320, 320) } };
    const t = fakeTelegram(photos);
    await syncTelegramPhoto(db, store, t.source, tg);
    photos[tg] = null;
    expect((await syncTelegramPhoto(db, store, t.source, tg, { force: true })).status).toBe("NONE");
    expect(await resolvePhoto(db, id)).toBeNull();
    expect(store.files.size).toBe(0);
  });

  it("a failing Telegram call never blanks a working avatar; it backs off exponentially", async () => {
    const { id, tg } = await hero();
    const t = fakeTelegram({ [tg]: { uniqueId: "ok", bytes: makeJpeg(320, 320) } });
    const clock = new FakeClock();
    await syncTelegramPhoto(db, store, t.source, tg, { now: clock.now });
    t.failNext(new TelegramPhotoError("Telegram getUserProfilePhotos: Bad Request", "API"));
    const r = await syncTelegramPhoto(db, store, t.source, tg, { now: clock.now, force: true });
    expect(r.status).toBe("ERROR");
    expect((await resolvePhoto(db, id))!.source).toBe("TELEGRAM"); // still shows the last good copy
    expect(errorBackoffMs(1)).toBe(3_600_000);
    expect(errorBackoffMs(3)).toBe(4 * 3_600_000);
    expect(errorBackoffMs(30)).toBe(24 * 3_600_000);
    // inside the backoff window no new request is made
    t.failNext(new TelegramPhotoError("should not be reached", "API"));
    clock.advance(1000);
    expect((await syncTelegramPhoto(db, store, t.source, tg, { now: clock.now })).status).toBe("SKIPPED_RECENT");
  });

  it("rejects bytes from Telegram that are not a valid image, keeping any existing good copy", async () => {
    const { tg } = await hero();
    const t = fakeTelegram({ [tg]: { uniqueId: "bad", bytes: HTML_DOCUMENT } });
    const r = await syncTelegramPhoto(db, store, t.source, tg);
    expect(r).toMatchObject({ status: "REJECTED", detail: "UNSUPPORTED_TYPE" });
    expect(store.files.size).toBe(0);
  });

  it("an admin override wins over the Telegram photo; removing it falls back to Telegram, then to the default", async () => {
    const { id, tg } = await hero();
    const t = fakeTelegram({ [tg]: { uniqueId: "tg", bytes: makeJpeg(320, 320, 2) } });
    await syncTelegramPhoto(db, store, t.source, tg);
    expect((await resolvePhoto(db, id))!.source).toBe("TELEGRAM");
    await upload(id, makePng(256, 256, 9));
    expect((await resolvePhoto(db, id))!.source).toBe("ADMIN");
    const view = await getHeroPhotoAdminView(db, id);
    expect(view.active).toBe("ADMIN");
    expect(view.admin).toMatchObject({ updatedBy: "admin", width: 256, mime: "image/png" });
    expect(view.telegram).toMatchObject({ status: "AVAILABLE" });
    expect(view.telegram!.url).toMatch(/^\/api\/admin\/heroes\/.+\/photo\/telegram\?v=/);
    await removeAdminPhoto(db, store, id, "admin");
    expect((await resolvePhoto(db, id))!.source).toBe("TELEGRAM");
    await db.query("delete from public.telegram_user_photos where telegram_user_id = $1", [tg]);
    expect(await resolvePhoto(db, id)).toBeNull();
  });

  it("batches are bounded, skip demo heroes, and stop at a rate limit", async () => {
    const ids = await seedHeroes(db, 6);
    const tgs = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by telegram_user_id")).map((r) => Number(r.telegram_user_id));
    expect(ids).toHaveLength(6);
    const photos: Record<number, { uniqueId: string; bytes: Buffer } | null> = {};
    for (const tg of tgs) photos[tg] = { uniqueId: `u${tg}`, bytes: makeJpeg(320, 320, tg % 200) };
    const t = fakeTelegram(photos);
    const first = await syncTelegramPhotoBatch(db, store, t.source, { limit: 4 });
    expect(first).toMatchObject({ checked: 4, byStatus: { UPDATED: 4 }, rateLimited: false });
    const second = await syncTelegramPhotoBatch(db, store, t.source, { limit: 4 });
    expect(second.checked).toBe(2); // only the two never-checked heroes are due
    t.failNext(new TelegramPhotoError("Telegram rate limit", "RATE_LIMITED", 5));
    const clock = new FakeClock(Date.now() + 2 * RECHECK_AFTER_MS);
    const third = await syncTelegramPhotoBatch(db, store, t.source, { limit: 10, now: clock.now });
    expect(third.rateLimited).toBe(true);
    expect(third.checked).toBe(1); // stopped at the first rate-limit response
  });
});

describe("photos are independent of names", () => {
  it("renaming a hero or changing the Telegram name/@username never moves or orphans its photo", async () => {
    const { id, tg } = await hero();
    const t = fakeTelegram({ [tg]: { uniqueId: "tg", bytes: makeJpeg(320, 320, 3) } });
    await syncTelegramPhoto(db, store, t.source, tg);
    await upload(id, makePng(128, 128, 6));
    const before = await resolvePhoto(db, id);
    const viewBefore = await getHeroPhotoAdminView(db, id);

    await renameHero(db, id, "Totally New Name", "admin");
    await db.query("update public.telegram_users set display_name = 'Celsius - Busy With Something Else Entirely', username = 'someone_else' where telegram_user_id = $1", [tg]);
    expect(await resolvePhoto(db, id)).toEqual(before);
    expect((await getHeroPhotoAdminView(db, id)).url).toBe(viewBefore.url);
    expect(await count("hero_photo_overrides")).toBe(1);
    expect(await count("telegram_user_photos")).toBe(1);
    expect(await count("characters")).toBe(1); // a changed username did not create a second hero
    expect((await loadPhotoBytes(db, store, id))!.bytes.byteLength).toBeGreaterThan(0);
  });

  it("the photo key is the hero id / Telegram id: another hero with the same display name gets no photo", async () => {
    const [a, b] = await seedHeroes(db, 2);
    await db.query("update public.telegram_users set display_name = 'Same Name'");
    await upload(a!, makePng());
    expect(await resolvePhoto(db, a!)).not.toBeNull();
    expect(await resolvePhoto(db, b!)).toBeNull();
  });
});

describe("the default avatar fallback and the public DTOs", () => {
  it("a hero with no photo has avatarUrl null everywhere (the UI draws the generated class portrait — never a broken image)", async () => {
    const [id] = await seedHeroes(db, 16);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    const settings = await loadSettings(db);
    const state = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes: await loadClasses(db, false) });
    expect(state.current!.fighters.every((f) => f.avatarUrl === null)).toBe(true);
    expect((await getCharacterDto(db, id!, settings, null))!.avatarUrl).toBeNull();
    expect((await getLeaderboard(db, "POWER", { allowDemo: true }))[0]!.avatarUrl).toBeNull();
    expect((await searchHeroes(db, "Hero", true))[0]!.avatarUrl).toBeNull();
    expect((await getHeroDetail(db, id!))!.photo.active).toBe("DEFAULT");
  });

  it("a photo reaches every surface: arena fighters, recent winners, hero page, search, leaderboard and admin lists", async () => {
    const ids = await seedHeroes(db, 16);
    const clock = new FakeClock();
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    for (const id of ids) await upload(id, makePng(128, 128, ids.indexOf(id)));
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const state1 = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes });
    for (const f of state1.current!.fighters) expect(f.avatarUrl).toMatch(new RegExp(`^/api/avatars/${f.characterId}\\?v=[0-9a-f]{12}$`));

    const [b] = await db.query<{ combat_ends_at: Date }>("select combat_ends_at from public.arena_battles order by sequence limit 1");
    clock.ms = new Date(b!.combat_ends_at).getTime() + 10;
    await advanceArena(db, ctx);
    const state2 = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes });
    expect(state2.recent[0]!.winner!.avatarUrl).toMatch(/^\/api\/avatars\//);
    expect(state2.recent[0]!.runnerUp!.avatarUrl).toMatch(/^\/api\/avatars\//);

    const id = ids[0]!;
    expect((await getCharacterDto(db, id, settings, null))!.avatarUrl).toMatch(/^\/api\/avatars\//);
    expect((await searchHeroes(db, "Hero", true)).every((h) => h.avatarUrl !== null)).toBe(true);
    expect((await getLeaderboard(db, "POWER", { allowDemo: true })).every((r) => r.avatarUrl !== null)).toBe(true);
    expect((await adminSearch(db, {})).heroes.every((h) => h.avatarUrl !== null)).toBe(true);
    expect((await getHeroDetail(db, id))!.photo).toMatchObject({ active: "ADMIN" });
  });

  it("the arena battle snapshot never contains the photo (it is presentation only, like the name)", async () => {
    await seedHeroes(db, 16);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    const [b] = await db.query<{ snapshot: unknown }>("select snapshot from public.arena_battles order by sequence limit 1");
    expect(JSON.stringify(b!.snapshot)).not.toMatch(/avatar|photo/i);
  });
});

describe("Telegram Bot API client", () => {
  const TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("picks the smallest size that is large enough for an avatar, else the largest", () => {
    const sizes = [160, 320, 640].map((n) => ({ file_id: `f${n}`, file_unique_id: `u${n}`, width: n, height: n }));
    expect(pickPhotoSize(sizes)!.file_id).toBe("f320");
    expect(pickPhotoSize(sizes.slice(0, 1))!.file_id).toBe("f160");
    expect(pickPhotoSize([])).toBeNull();
  });

  it("calls getUserProfilePhotos then getFile then the file URL, and returns the newest photo", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url.replace(TOKEN, "<token>"));
      if (url.includes("/getUserProfilePhotos")) return json({ ok: true, result: { total_count: 2, photos: [[{ file_id: "a160", file_unique_id: "ua", width: 160, height: 160 }, { file_id: "a640", file_unique_id: "ub", width: 640, height: 640 }]] } });
      if (url.includes("/getFile")) return json({ ok: true, result: { file_id: "a640", file_path: "photos/file_1.jpg" } });
      return new Response(new Uint8Array(makeJpeg(640, 640)), { status: 200 });
    }) as typeof fetch;
    const source = createBotApiPhotoSource({ token: TOKEN, fetchImpl });
    const photo = await source.currentPhoto(777);
    expect(photo).toEqual({ fileId: "a640", fileUniqueId: "ub", width: 640, height: 640 });
    const file = await source.download("a640");
    expect(file.bytes.byteLength).toBe(makeJpeg(640, 640).length);
    expect(seen[0]).toBe("https://api.telegram.org/bot<token>/getUserProfilePhotos?user_id=777&limit=1");
    expect(seen[1]).toBe("https://api.telegram.org/bot<token>/getFile?file_id=a640");
    expect(seen[2]).toBe("https://api.telegram.org/file/bot<token>/photos/file_1.jpg");
  });

  it("reports 'no photo' as null, and surfaces API errors and rate limits without ever leaking the bot token", async () => {
    const empty = createBotApiPhotoSource({ token: TOKEN, fetchImpl: (async () => json({ ok: true, result: { total_count: 0, photos: [] } })) as typeof fetch });
    expect(await empty.currentPhoto(1)).toBeNull();

    const limited = createBotApiPhotoSource({ token: TOKEN, fetchImpl: (async () => json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }, 429)) as typeof fetch });
    await expect(limited.currentPhoto(1)).rejects.toMatchObject({ kind: "RATE_LIMITED", retryAfterS: 7 });

    const leaky = createBotApiPhotoSource({ token: TOKEN, fetchImpl: (async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getUserProfilePhotos`); }) as typeof fetch });
    const err = (await leaky.currentPhoto(1).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[token]");

    const bad = createBotApiPhotoSource({ token: TOKEN, fetchImpl: (async () => json({ ok: false, error_code: 400, description: `Bad Request: user ${TOKEN} not found` }, 400)) as typeof fetch });
    expect(((await bad.currentPhoto(1).catch((e: unknown) => e)) as Error).message).not.toContain(TOKEN);
  });
});
