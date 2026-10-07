/**
 * Server-side image inspection for hero profile photos. The CLIENT-DECLARED type is never trusted: the
 * bytes are sniffed (magic numbers), the container structure is walked, and the real dimensions are read
 * from the headers. Only static PNG / JPEG / WebP pass — never SVG (scriptable), GIF, PDF, HTML, executables
 * or anything that merely starts with an image signature and carries other data behind it.
 *
 * Pure (no I/O) so it can be unit-tested exhaustively and run anywhere.
 */

export const AVATAR_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AvatarMime = (typeof AVATAR_MIMES)[number];

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIN_SIDE = 64;
export const AVATAR_MAX_SIDE = 4096;

export type ImageProblem = "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "MIME_MISMATCH" | "CORRUPT" | "ANIMATED" | "TOO_SMALL" | "DIMENSIONS_TOO_LARGE";

export type ImageInspection =
  | { ok: true; mime: AvatarMime; ext: "png" | "jpg" | "webp"; width: number; height: number; bytes: number }
  | { ok: false; problem: ImageProblem; message: string };

const MESSAGES: Record<ImageProblem, string> = {
  EMPTY: "No image was sent.",
  TOO_LARGE: `The image is larger than ${AVATAR_MAX_BYTES / (1024 * 1024)} MB.`,
  UNSUPPORTED_TYPE: "Only PNG, JPEG or WebP images are accepted.",
  MIME_MISMATCH: "The file's content does not match its declared type.",
  CORRUPT: "The image is damaged or has extra data after it.",
  ANIMATED: "Animated images are not accepted — use a still image.",
  TOO_SMALL: `The image must be at least ${AVATAR_MIN_SIDE}×${AVATAR_MIN_SIDE} pixels.`,
  DIMENSIONS_TOO_LARGE: `The image can be at most ${AVATAR_MAX_SIDE}×${AVATAR_MAX_SIDE} pixels.`,
};

const fail = (problem: ImageProblem): ImageInspection => ({ ok: false, problem, message: MESSAGES[problem] });

const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32le = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

type Parsed = { width: number; height: number } | "CORRUPT" | "ANIMATED";

function parsePng(b: Uint8Array): Parsed {
  let off = 8;
  let width = 0;
  let height = 0;
  let first = true;
  while (off + 12 <= b.length) {
    const len = u32be(b, off);
    const type = ascii(b, off + 4, 4);
    if (off + 12 + len > b.length) return "CORRUPT";
    if (first) {
      if (type !== "IHDR" || len !== 13) return "CORRUPT";
      width = u32be(b, off + 8);
      height = u32be(b, off + 12);
      first = false;
    } else if (type === "acTL") {
      return "ANIMATED";
    }
    off += 12 + len;
    if (type === "IEND") return off === b.length && width > 0 && height > 0 ? { width, height } : "CORRUPT";
  }
  return "CORRUPT";
}

function parseJpeg(b: Uint8Array): Parsed {
  let off = 2;
  let dims: { width: number; height: number } | null = null;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return "CORRUPT";
    let marker = b[off + 1]!;
    while (marker === 0xff && off + 2 < b.length) {
      off++;
      marker = b[off + 1]!;
    }
    off += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone markers
    if (marker === 0xd9) return "CORRUPT"; // EOI before any scan data
    const len = u16be(b, off);
    if (len < 2 || off + len > b.length) return "CORRUPT";
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8) return "CORRUPT";
      dims = { height: u16be(b, off + 3), width: u16be(b, off + 5) };
    }
    off += len;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows. The file must end with EOI and nothing after it.
      if (!dims || dims.width === 0 || dims.height === 0) return "CORRUPT";
      return b.length - 2 >= off && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 ? dims : "CORRUPT";
    }
  }
  return "CORRUPT";
}

function parseWebp(b: Uint8Array): Parsed {
  if (b.length < 30) return "CORRUPT";
  if (u32le(b, 4) + 8 !== b.length) return "CORRUPT"; // RIFF size must describe exactly this file
  const kind = ascii(b, 12, 4);
  if (kind === "VP8X") {
    if ((b[20]! & 0x02) !== 0) return "ANIMATED";
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return "CORRUPT";
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return "CORRUPT";
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return "CORRUPT";
}

const normalizeMime = (m: string): string => {
  const base = m.split(";")[0]!.trim().toLowerCase();
  return base === "image/jpg" || base === "image/pjpeg" ? "image/jpeg" : base;
};

/**
 * Validates an uploaded avatar. `declaredMime` is only a consistency check — the content decides.
 */
export function inspectImage(bytes: Uint8Array, opts: { declaredMime?: string | null; maxBytes?: number } = {}): ImageInspection {
  if (bytes.length === 0) return fail("EMPTY");
  if (bytes.length > (opts.maxBytes ?? AVATAR_MAX_BYTES)) return fail("TOO_LARGE");

  let mime: AvatarMime;
  let ext: "png" | "jpg" | "webp";
  let parsed: Parsed;
  if (bytes.length >= 8 && u32be(bytes, 0) === 0x89504e47 && u32be(bytes, 4) === 0x0d0a1a0a) {
    mime = "image/png";
    ext = "png";
    parsed = parsePng(bytes);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
    ext = "jpg";
    parsed = parseJpeg(bytes);
  } else if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mime = "image/webp";
    ext = "webp";
    parsed = parseWebp(bytes);
  } else {
    return fail("UNSUPPORTED_TYPE");
  }

  const declared = opts.declaredMime ? normalizeMime(opts.declaredMime) : "";
  if (declared && declared !== "application/octet-stream" && declared !== mime) return fail("MIME_MISMATCH");
  if (parsed === "CORRUPT" || parsed === "ANIMATED") return fail(parsed);
  if (parsed.width < AVATAR_MIN_SIDE || parsed.height < AVATAR_MIN_SIDE) return fail("TOO_SMALL");
  if (parsed.width > AVATAR_MAX_SIDE || parsed.height > AVATAR_MAX_SIDE) return fail("DIMENSIONS_TOO_LARGE");
  return { ok: true, mime, ext, width: parsed.width, height: parsed.height, bytes: bytes.length };
}
