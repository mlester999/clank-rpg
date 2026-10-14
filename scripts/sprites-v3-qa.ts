/**
 * HERO RENDERER v3 — visual QA artifacts, rendered from the REAL engines (v2 through its shipped atlases and the runtime compositor, v3 through
 * the procedural renderer). Nothing here is hand-made: every pixel comes from the production appearance generator → stored sprite config →
 * renderer.
 *
 *   pnpm exec tsx scripts/sprites-v3-qa.ts --out docs/qa/hero-renderer-v3 [--only comparisons,warriors,classes,anim,videos,edge]
 *
 *   A  01-old-vs-new-warriors-zoom.png        the same warriors, v2 | v3, 6× nearest
 *   B  02-old-vs-new-warriors-arena-size.png  the same warriors at 1× and 2× (≈ the stage scale on a desktop)
 *   C  03-faces-old-vs-new.png                head close-ups, 10×
 *   D  04-weapon-grips-old-vs-new.png         hands on weapons (one-hand, two-hand, bow draw, shield + mace, staff), 8×
 *   E  05-twenty-common-warriors.png          F  06-twenty-legendary-warriors.png
 *   G  07-all-classes-all-rarities.png        6 classes × 4 rarities × 3 heroes
 *   H  08-animation-contact-<class>.png       every frame of every clip, one hero per archetype
 *   I  videos/*.mp4 + *.gif                   real engine frames at their real timing (60 Hz), moving heroes over a ground line
 *      09-edge-cases.png                      cross-class cosmetic overrides, hair under hoods / helms, beards under bevors …
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createCanvas, GlobalFonts, ImageData, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

import { getHeroSheet, type CanvasFactory, type SpriteSource } from "../src/components/sprites/compositor";
import { rollAppearance, type Rarity } from "../src/domain/character/appearance";
import { DEFAULT_CLASSES } from "../src/domain/content";
import { deriveSpriteConfig, type SpriteConfig } from "../src/domain/sprites/config";
import { parseManifest, type ClipKey } from "../src/domain/sprites/spec";
import { CLASS_ARCHETYPES } from "../src/domain/sprites/v3/anatomy";
import { TIMING, WORLD_PER_PX, type ClipKey3 } from "../src/domain/sprites/v3/clips";
import { genomeOf } from "../src/domain/sprites/v3/genome";
import { loadoutOf } from "../src/domain/sprites/v3/gear/loadout";
import { heroPalette } from "../src/domain/sprites/v3/palette";
import { ANCHOR, FRAME_H, FRAME_W, heroOf, renderClipFrame, type Hero } from "../src/domain/sprites/v3/render";
import { createRng } from "../src/domain/util/rng";

const arg = (n: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const OUT = arg("out", "docs/qa/hero-renderer-v3") as string;
const ONLY = new Set((arg("only", "comparisons,warriors,classes,anim,videos,edge") as string).split(","));
mkdirSync(OUT, { recursive: true });
try {
  GlobalFonts.registerFromPath(path.join(process.cwd(), "public", "fonts", "Inter-SemiBold.ttf"), "QA");
} catch {
  /* system font */
}

const RARITIES: readonly Rarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
const cls = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!;
const configOf = (id: string, seed: string, rarity: Rarity): SpriteConfig => deriveSpriteConfig(rollAppearance(createRng(seed), cls(id), rarity), cls(id).look, rarity);
const v3Hero = (id: string, seed: string, rarity: Rarity): Hero => heroOf({ config: configOf(id, seed, rarity), colors: cls(id).look.colors, rarity });
const BG = ["#232838", "#1e2a3e", "#2a2240", "#33291c"];

// ------------------------------------------------------------------------------------------------ v2 (the shipped atlases + compositor)

const factory: CanvasFactory = (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement;
let v2src: SpriteSource | null = null;
async function v2(): Promise<SpriteSource> {
  if (v2src) return v2src;
  const dir = path.join(process.cwd(), "public", "sprites", "clank-dev-v2");
  const manifest = parseManifest(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  const images: SpriteSource["images"] = {};
  for (const [k, f] of Object.entries(manifest.images)) images[k] = (await loadImage(path.join(dir, f))) as unknown as CanvasImageSource;
  return (v2src = { manifest, images, factory });
}
async function v2Frame(id: string, seed: string, rarity: Rarity, clip: ClipKey = "idle", frame = 0): Promise<Canvas> {
  const src = await v2();
  const sheet = getHeroSheet(src, configOf(id, seed, rarity), cls(id).look.colors, rarity);
  const c = sheet.plan.idleClip === "idle2" && clip === "idle" ? "idle2" : clip;
  const strip = sheet.strip(c) as unknown as Canvas;
  const out = createCanvas(96, 80);
  out.getContext("2d").drawImage(strip as never, frame * 96, 0, 96, 80, 0, 0, 96, 80);
  return out;
}
const v3Canvas = (h: Hero, clip: ClipKey3 = "idle", f = 0): Canvas => {
  const c = createCanvas(FRAME_W, FRAME_H);
  const k = clip === "idle" && h.g.stance === 1 ? "idle2" : clip;
  c.getContext("2d").putImageData(new ImageData(renderClipFrame(h, k, f).rgba, FRAME_W, FRAME_H), 0, 0);
  return c;
};

// ------------------------------------------------------------------------------------------------ layout helpers

function label(g: SKRSContext2D, text: string, x: number, y: number, size = 14, color = "#c9d1e3"): void {
  g.font = `${size}px QA, sans-serif`;
  g.fillStyle = color;
  g.fillText(text, x, y);
}
/** Draws a crop (sx,sy,w,h of a frame canvas, both renderers anchored at the same feet point) scaled nearest. */
function blit(g: SKRSContext2D, src: Canvas, crop: { x: number; y: number; w: number; h: number }, dx: number, dy: number, z: number): void {
  g.imageSmoothingEnabled = false;
  g.drawImage(src as never, crop.x, crop.y, crop.w, crop.h, dx, dy, crop.w * z, crop.h * z);
}
const save = (name: string, c: Canvas) => {
  writeFileSync(path.join(OUT, name), c.toBuffer("image/png"));
  console.log(`  ${name} (${c.width}×${c.height})`);
};
// v2's feet are at (40, 76), v3's at ANCHOR: crops are taken relative to each one's feet so the two line up
const V2_ANCHOR = { x: 40, y: 76 };
const cropAt = (anchor: { x: number; y: number }, dx: number, dy: number, w: number, h: number) => ({ x: anchor.x + dx, y: anchor.y + dy, w, h });

// ------------------------------------------------------------------------------------------------ A–D comparisons

async function comparisons(): Promise<void> {
  const seeds = ["qa-w-1", "qa-w-2", "qa-w-3", "qa-w-4", "qa-w-5", "qa-w-6"];
  const rar: Rarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY", "COMMON", "LEGENDARY"];
  // A: large zoom, idle + attack impact
  {
    const z = 6;
    const cw = 64 * z;
    const ch = 70 * z;
    const c = createCanvas(seeds.length * cw, 2 * ch + 60);
    const g = c.getContext("2d");
    g.fillStyle = "#1a1d29";
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < seeds.length; i++) {
      const h = v3Hero("warrior", seeds[i]!, rar[i]!);
      g.fillStyle = BG[RARITIES.indexOf(rar[i]!)]!;
      g.fillRect(i * cw, 30, cw, ch);
      g.fillRect(i * cw, 30 + ch + 30, cw, ch);
      blit(g, await v2Frame("warrior", seeds[i]!, rar[i]!), cropAt(V2_ANCHOR, -26, -64, 64, 70), i * cw, 30, z);
      blit(g, v3Canvas(h), cropAt(ANCHOR, -26, -64, 64, 70), i * cw, 30 + ch + 30, z);
      label(g, `${rar[i]} · ${h.g.arch}`, i * cw + 10, 20, 16);
    }
    label(g, "v2 (live today)", 10, 30 + ch - 10, 20, "#ff9a8a");
    label(g, "v3 (procedural)", 10, 30 + 2 * ch + 20, 20, "#8affb4");
    save("01-old-vs-new-warriors-zoom.png", c);
  }
  // B: arena size — 1× and 2× (the stage draws ≈ 2 device px per sprite px on a desktop)
  {
    const c = createCanvas(seeds.length * 150 + 40, 2 * 175 + 60);
    const g = c.getContext("2d");
    g.fillStyle = "#2b3040";
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < seeds.length; i++) {
      const h = v3Hero("warrior", seeds[i]!, rar[i]!);
      const a = await v2Frame("warrior", seeds[i]!, rar[i]!);
      const b = v3Canvas(h);
      blit(g, a, cropAt(V2_ANCHOR, -26, -64, 64, 70), 20 + i * 150, 30, 1);
      blit(g, a, cropAt(V2_ANCHOR, -26, -64, 64, 70), 20 + i * 150 + 18, 30 + 30, 1.5);
      blit(g, b, cropAt(ANCHOR, -26, -64, 64, 70), 20 + i * 150, 205, 1);
      blit(g, b, cropAt(ANCHOR, -26, -64, 64, 70), 20 + i * 150 + 18, 205 + 30, 1.5);
    }
    // a true 2× strip below for each
    label(g, "v2 — 1× and 1.5× (nearest)", 20, 20, 13, "#ff9a8a");
    label(g, "v3 — 1× and 1.5× (nearest)", 20, 195, 13, "#8affb4");
    save("02-old-vs-new-warriors-arena-size.png", c);
  }
  // C: faces
  {
    const z = 10;
    const n = 8;
    const cw = 22 * z;
    const c = createCanvas(n * cw, 2 * 22 * z + 50);
    const g = c.getContext("2d");
    g.fillStyle = "#1a1d29";
    g.fillRect(0, 0, c.width, c.height);
    const people: Array<[string, Rarity]> = [["warrior", "COMMON"], ["rogue", "COMMON"], ["ranger", "RARE"], ["mage", "RARE"], ["cleric", "EPIC"], ["warrior", "RARE"], ["ranger", "COMMON"], ["cleric", "COMMON"]];
    for (let i = 0; i < n; i++) {
      const [id, r] = people[i]!;
      const h = v3Hero(id, `qa-face-${i}`, r);
      const fr = renderClipFrame(h, h.g.stance === 1 ? "idle2" : "idle", 0);
      const e = fr.meta.face.eyes[0];
      const hx = e ? e.x - 12 : ANCHOR.x - 8;
      const hy = e ? e.y - 11 : ANCHOR.y - 48;
      const b = v3Canvas(h);
      // v2: the head region relative to its feet (v2 heads sit ≈ 40–60 px above the feet)
      const a = await v2Frame(id, `qa-face-${i}`, r);
      blit(g, a, { x: V2_ANCHOR.x - 9, y: V2_ANCHOR.y - 50, w: 22, h: 22 }, i * cw, 20, z);
      blit(g, b, { x: hx, y: hy, w: 22, h: 22 }, i * cw, 40 + 22 * z, z);
      label(g, `${id} ${r.toLowerCase()}`, i * cw + 8, 14, 13);
    }
    save("03-faces-old-vs-new.png", c);
  }
  // D: hands on weapons
  {
    const z = 8;
    const cases: Array<{ id: string; arch: string; clip: ClipKey3; f: number; note: string }> = [
      { id: "warrior", arch: "warrior", clip: "idle", f: 0, note: "one-handed sword" },
      { id: "warrior", arch: "warrior-brute", clip: "idle", f: 0, note: "greatsword, two hands" },
      { id: "ranger", arch: "ranger", clip: "attack_shoot", f: 3, note: "bow at full draw" },
      { id: "tank", arch: "tank", clip: "idle", f: 0, note: "mace + shield on forearm" },
      { id: "mage", arch: "mage-battle", clip: "idle", f: 0, note: "staff in both hands" },
      { id: "rogue", arch: "rogue", clip: "attack_thrust", f: 3, note: "twin daggers" },
    ];
    const cw = 40 * z;
    const c = createCanvas(cases.length * cw, 2 * 40 * z + 60);
    const g = c.getContext("2d");
    g.fillStyle = "#1a1d29";
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < cases.length; i++) {
      const k = cases[i]!;
      let h: Hero | null = null;
      let seed = "";
      for (let s = 0; s < 300 && !h; s++) {
        const cand = v3Hero(k.id, `qa-grip-${s}`, "RARE");
        if (cand.g.arch === k.arch) {
          h = cand;
          seed = `qa-grip-${s}`;
        }
      }
      if (!h) continue;
      const fr = renderClipFrame(h, k.clip, k.f);
      const [gx, gy] = fr.meta.handN;
      const b = v3Canvas(h, k.clip, k.f);
      const v2clip: ClipKey = k.clip === "attack_shoot" ? "attack_shoot" : k.clip === "attack_thrust" ? "attack_thrust" : "idle";
      const a = await v2Frame(k.id, seed, "RARE", v2clip, k.clip === "idle" ? 0 : 3);
      // v2 has no hand metadata: the same body region relative to its feet (hands ≈ 30–40 px above the feet, in front)
      blit(g, a, { x: V2_ANCHOR.x - 12, y: V2_ANCHOR.y - 46, w: 40, h: 40 }, i * cw, 26, z);
      blit(g, b, { x: Math.max(0, Math.min(FRAME_W - 40, gx - 17)), y: Math.max(0, Math.min(FRAME_H - 40, gy - 15)), w: 40, h: 40 }, i * cw, 46 + 40 * z, z);
      label(g, k.note, i * cw + 8, 18, 14);
    }
    save("04-weapon-grips-old-vs-new.png", c);
  }
}

// ------------------------------------------------------------------------------------------------ E–G sheets

function grid(name: string, heroes: Array<{ h: Hero; bg: string; text?: string }>, cols: number, z: number, crop = { dx: -28, dy: -62, w: 60, h: 68 }): void {
  const cw = crop.w * z;
  const ch = crop.h * z + (heroes.some((x) => x.text) ? 18 : 0);
  const rows = Math.ceil(heroes.length / cols);
  const c = createCanvas(cols * cw, rows * ch);
  const g = c.getContext("2d");
  g.fillStyle = "#1a1d29";
  g.fillRect(0, 0, c.width, c.height);
  heroes.forEach((x, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    g.fillStyle = x.bg;
    g.fillRect(col * cw, row * ch, cw, ch);
    blit(g, v3Canvas(x.h), cropAt(ANCHOR, crop.dx, crop.dy, crop.w, crop.h), col * cw, row * ch, z);
    if (x.text) label(g, x.text, col * cw + 4, row * ch + ch - 5, 11, "#aab3c8");
  });
  save(name, c);
}

function sheets(): void {
  const names = (h: Hero) => h.lo.names.slice(0, 3).join(" · ");
  grid("05-twenty-common-warriors.png", Array.from({ length: 20 }, (_, i) => {
    const h = v3Hero("warrior", `qa-cw-${i}`, "COMMON");
    return { h, bg: BG[0]!, text: names(h) };
  }), 10, 3);
  grid("06-twenty-legendary-warriors.png", Array.from({ length: 20 }, (_, i) => {
    const h = v3Hero("warrior", `qa-lw-${i}`, "LEGENDARY");
    return { h, bg: BG[3]!, text: names(h) };
  }), 10, 3);
  const all: Array<{ h: Hero; bg: string }> = [];
  for (const id of ["warrior", "tank", "rogue", "ranger", "mage", "cleric"]) for (const r of RARITIES) for (let k = 0; k < 3; k++) all.push({ h: v3Hero(id, `qa-all-${id}-${r}-${k}`, r), bg: BG[RARITIES.indexOf(r)]! });
  grid("07-all-classes-all-rarities.png", all, 12, 3);
}

// ------------------------------------------------------------------------------------------------ H animation contact sheets

function contact(): void {
  const CLIPS: ClipKey3[] = ["idle", "idle2", "move", "run", "attack_slash", "skill", "hit", "block", "ko", "victory", "turn"];
  for (const id of ["warrior", "tank", "rogue", "ranger", "mage", "cleric"]) {
    const archs = CLASS_ARCHETYPES[id as keyof typeof CLASS_ARCHETYPES];
    const z = 2;
    const cw = 64 * z;
    const ch = 72 * z;
    const maxF = 10;
    const rows = archs.length * CLIPS.length;
    const c = createCanvas(110 + maxF * cw, rows * ch);
    const g = c.getContext("2d");
    g.fillStyle = "#1a1d29";
    g.fillRect(0, 0, c.width, c.height);
    archs.forEach((arch, ai) => {
      let h: Hero | null = null;
      for (let s = 0; s < 400 && !h; s++) {
        const cand = v3Hero(id, `qa-anim-${s}`, RARITIES[(s + ai) % 4]!);
        if (cand.g.arch === arch) h = cand;
      }
      if (!h) return;
      CLIPS.forEach((clip0, ci) => {
        const clip = clip0 === "attack_slash" ? h!.lo.attack : clip0;
        const row = ai * CLIPS.length + ci;
        label(g, `${arch}`, 6, row * ch + 22, 12, "#8affb4");
        label(g, clip, 6, row * ch + 40, 12);
        for (let f = 0; f < TIMING[clip].frames; f++) {
          g.fillStyle = (f + row) % 2 ? "#232838" : "#262b3b";
          g.fillRect(110 + f * cw, row * ch, cw, ch);
          if (TIMING[clip].impact === f) {
            g.strokeStyle = "#ffcc33";
            g.strokeRect(110 + f * cw + 1, row * ch + 1, cw - 2, ch - 2);
          }
          const fr = createCanvas(FRAME_W, FRAME_H);
          fr.getContext("2d").putImageData(new ImageData(renderClipFrame(h!, clip, f).rgba, FRAME_W, FRAME_H), 0, 0);
          blit(g, fr, { x: ANCHOR.x - 30, y: ANCHOR.y - 66, w: 64, h: 72 }, 110 + f * cw, row * ch, z);
        }
      });
    });
    save(`08-animation-contact-${id}.png`, c);
  }
}

// ------------------------------------------------------------------------------------------------ I videos (real frames, real timing)

interface Seg {
  clip: ClipKey3;
  /** Duration in seconds (loops repeat; one-shots hold their last frame). */
  sec: number;
  /** Ground speed while this segment plays (world units / s): the hero moves across the frame and the cycle is stride-locked. */
  speed?: number;
  /** Facing (-1 mirrors). */
  face?: 1 | -1;
}

function sequence(name: string, h: Hero, segs: Seg[], title: string): void {
  const dir = path.join(OUT, "videos", `.${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const FPS = 60;
  const Z = 4;
  const W = 220;
  const H = 96;
  let n = 0;
  let x = 60;
  let dist = 0; // world units walked (the stride-locked clock)
  for (const s of segs) {
    const T = TIMING[s.clip];
    const steps = Math.round(s.sec * FPS);
    for (let i = 0; i < steps; i++) {
      const t = i / FPS;
      let f: number;
      if (s.clip === "move" || s.clip === "run") {
        const ref = T.refSpeed ?? 62;
        // the arena's move clock: real time × speed / 62, then (run) scaled to its own reference speed
        f = Math.floor(((dist / ref) * T.fps)) % T.frames;
        dist += (s.speed ?? 62) / FPS;
        x += (((s.speed ?? 62) / WORLD_PER_PX) / FPS) * (s.face ?? 1);
      } else f = T.loop ? Math.floor(t * T.fps) % T.frames : Math.min(T.frames - 1, Math.floor(t * T.fps));
      const c = createCanvas(W * Z, H * Z + 36);
      const g = c.getContext("2d");
      g.fillStyle = "#1c2030";
      g.fillRect(0, 0, c.width, c.height);
      // floor
      g.fillStyle = "#2c3245";
      g.fillRect(0, (ANCHOR.y + 6) * Z, c.width, c.height);
      for (let k = 0; k < W; k += 12) {
        g.fillStyle = "#353c52";
        g.fillRect(k * Z, (ANCHOR.y + 6) * Z, Z * 6, Z);
      }
      const fr = createCanvas(FRAME_W, FRAME_H);
      fr.getContext("2d").putImageData(new ImageData(renderClipFrame(h, s.clip, f).rgba, FRAME_W, FRAME_H), 0, 0);
      g.imageSmoothingEnabled = false;
      g.save();
      const px = Math.round(x);
      g.translate(px * Z, 6 * Z);
      if ((s.face ?? 1) < 0) {
        g.translate(ANCHOR.x * Z * 2 + Z, 0);
        g.scale(-1, 1);
      }
      g.drawImage(fr as never, 0, 0, FRAME_W, FRAME_H, 0, 0, FRAME_W * Z, FRAME_H * Z);
      g.restore();
      label(g, `${title}   ·   ${s.clip}  frame ${f + 1}/${T.frames}`, 10, H * Z + 26, 22);
      writeFileSync(path.join(dir, `f${String(n++).padStart(5, "0")}.png`), c.toBuffer("image/png"));
    }
  }
  const mp4 = path.join(OUT, "videos", `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", mp4]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf", "fps=30,scale=iw/2:-1:flags=neighbor,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none", path.join(OUT, "videos", `${name}.gif`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`  videos/${name}.mp4 + .gif (${n} frames @ ${FPS} Hz)`);
}

function videos(): void {
  mkdirSync(path.join(OUT, "videos"), { recursive: true });
  const pick = (id: string, arch: string, r: Rarity): Hero => {
    for (let s = 0; s < 400; s++) {
      const h = v3Hero(id, `qa-vid-${s}`, r);
      if (h.g.arch === arch) return h;
    }
    return v3Hero(id, "qa-vid-0", r);
  };
  const atk = (h: Hero) => h.lo.attack;
  const dur = (c: ClipKey3) => TIMING[c].frames / TIMING[c].fps;
  const w = pick("warrior", "warrior", "EPIC");
  sequence("warrior-idle-run-attack-recover", w, [{ clip: "idle", sec: 1.4 }, { clip: "run", sec: 1.6, speed: 96 }, { clip: atk(w), sec: dur(atk(w)) }, { clip: "idle", sec: 1.2 }], "Warrior (vanguard)");
  const t = pick("tank", "tank", "RARE");
  sequence("tank-walk-block-attack-recover", t, [{ clip: "move", sec: 2.0, speed: 54 }, { clip: "block", sec: dur("block") + 0.2 }, { clip: atk(t), sec: dur(atk(t)) }, { clip: "idle", sec: 1.0 }], "Tank (bulwark)");
  const r = pick("rogue", "rogue", "EPIC");
  sequence("rogue-run-strike-reposition", r, [{ clip: "run", sec: 1.4, speed: 92 }, { clip: atk(r), sec: dur(atk(r)) }, { clip: "move", sec: 1.2, speed: 70, face: -1 }, { clip: "idle", sec: 0.8 }], "Rogue (cutthroat)");
  const ra = pick("ranger", "ranger", "LEGENDARY");
  sequence("ranger-move-stop-aim-fire-recover", ra, [{ clip: "move", sec: 1.6, speed: 62 }, { clip: "idle", sec: 0.35 }, { clip: atk(ra), sec: dur(atk(ra)) }, { clip: atk(ra), sec: dur(atk(ra)) }, { clip: "idle", sec: 0.9 }], "Ranger (scout)");
  const m = pick("mage", "mage", "RARE");
  sequence("mage-move-cast-release", m, [{ clip: "move", sec: 1.6, speed: 54 }, { clip: "skill", sec: dur("skill") }, { clip: atk(m), sec: dur(atk(m)) }, { clip: "idle", sec: 1.0 }], "Mage (scholar)");
  const c = pick("cleric", "cleric", "EPIC");
  sequence("cleric-idle-heal-recover", c, [{ clip: "idle", sec: 1.0 }, { clip: "skill", sec: dur("skill") }, { clip: "idle", sec: 1.2 }], "Cleric (priest)");
  sequence("hit-then-ko", pick("warrior", "warrior-brute", "LEGENDARY"), [{ clip: "idle", sec: 0.8 }, { clip: "hit", sec: dur("hit") }, { clip: "idle", sec: 0.4 }, { clip: "hit", sec: dur("hit") }, { clip: "ko", sec: dur("ko") + 1.0 }], "Hit → KO (brute)");
  sequence("victory", pick("tank", "tank-juggernaut", "LEGENDARY"), [{ clip: "idle", sec: 0.8 }, { clip: "victory", sec: 2.4 }], "Victory (juggernaut)");
  sequence("facing-change", pick("ranger", "ranger-warden", "EPIC"), [{ clip: "move", sec: 1.2, speed: 62 }, { clip: "turn", sec: dur("turn"), face: -1 }, { clip: "move", sec: 1.2, speed: 62, face: -1 }, { clip: "turn", sec: dur("turn") }, { clip: "idle", sec: 0.8 }], "Facing change (warden)");
}

// ------------------------------------------------------------------------------------------------ edge cases

function edge(): void {
  const cases: Array<{ id: string; r: Rarity; over: Record<string, unknown>; text: string }> = [
    { id: "tank", r: "LEGENDARY", over: { headgear: "crown" }, text: "tank + crown (override)" },
    { id: "warrior", r: "RARE", over: { headgear: "hat" }, text: "warrior + wizard hat" },
    { id: "mage", r: "EPIC", over: { headgear: "helm" }, text: "mage + helm" },
    { id: "rogue", r: "COMMON", over: { hairStyle: 2 }, text: "long hair under a hood" },
    { id: "warrior", r: "COMMON", over: { headgear: null, hairStyle: 3 }, text: "mohawk, bare head" },
    { id: "tank", r: "COMMON", over: { beard: "long" }, text: "long beard + bevor" },
    { id: "cleric", r: "LEGENDARY", over: { beard: "full", hairStyle: 5 }, text: "curls + beard + crown" },
    { id: "ranger", r: "EPIC", over: { accessory: "goggles" }, text: "goggles (accessory)" },
    { id: "warrior", r: "LEGENDARY", over: { cape: false }, text: "legendary, no cape" },
    { id: "rogue", r: "LEGENDARY", over: { headgear: null, hairStyle: 1 }, text: "rogue, hood removed" },
    { id: "mage", r: "COMMON", over: { hairStyle: null }, text: "bald under a hat" },
    { id: "cleric", r: "RARE", over: { headgear: "hood" }, text: "cleric + hood" },
  ];
  const heroes = cases.map((k, i) => {
    const config = configOf(k.id, `qa-edge-${i}`, k.r);
    const g0 = { ...genomeOf({ config, colors: cls(k.id).look.colors, rarity: k.r }), ...k.over } as ReturnType<typeof genomeOf>;
    const pal = heroPalette(g0, config);
    return { h: { g: g0, pal, lo: loadoutOf(g0, pal) } as Hero, bg: BG[RARITIES.indexOf(k.r)]!, text: k.text };
  });
  grid("09-edge-cases.png", heroes, 6, 3);
}

async function main(): Promise<void> {
  console.log(`hero renderer v3 QA → ${OUT}`);
  if (ONLY.has("comparisons")) await comparisons();
  if (ONLY.has("warriors") || ONLY.has("classes")) sheets();
  if (ONLY.has("anim")) contact();
  if (ONLY.has("edge")) edge();
  if (ONLY.has("videos")) videos();
}

void main();
