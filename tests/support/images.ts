import { deflateSync } from "node:zlib";

/**
 * Tiny, structurally valid image files for upload tests. They are real containers (a PNG here decodes in
 * any viewer) but deliberately small; the server only inspects headers and structure.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const be32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
}

/** A solid-colour PNG. `tint` varies the pixels so two images get different hashes. */
export function makePng(width = 128, height = 128, tint = 0): Buffer {
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]);
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) row.writeUInt32BE(((0x30a0e0 + tint) << 8) | 0xff, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A structurally valid JPEG container (SOI · JFIF · SOF0 · SOS · scan data · EOI). Not meant to be decoded. */
export function makeJpeg(width = 128, height = 128, tint = 0): Buffer {
  const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08]), u16(height), u16(width), Buffer.from([0x01, 0x01, 0x11, 0x00]),
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    Buffer.from([0x12, 0x34, tint & 0xfe, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A structurally valid lossless WebP (VP8L) header + padding. `animated` produces a VP8X animation flag instead. */
export function makeWebp(width = 128, height = 128, opts: { animated?: boolean; tint?: number } = {}): Buffer {
  let chunk: Buffer;
  if (opts.animated) {
    const payload = Buffer.alloc(10);
    payload[0] = 0x02; // animation flag
    payload.writeUIntLE(width - 1, 4, 3);
    payload.writeUIntLE(height - 1, 7, 3);
    chunk = Buffer.concat([Buffer.from("VP8X"), le32(10), payload]);
  } else {
    const payload = Buffer.alloc(10);
    payload[0] = 0x2f;
    payload.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
    payload[9] = (opts.tint ?? 0) & 0xff;
    chunk = Buffer.concat([Buffer.from("VP8L"), le32(payload.length), payload]);
  }
  return Buffer.concat([Buffer.from("RIFF"), le32(4 + chunk.length), Buffer.from("WEBP"), chunk]);
}

function le32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

export const SVG_WITH_SCRIPT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>alert(1)</script></svg>');
export const HTML_DOCUMENT = Buffer.from("<!doctype html><script>alert(1)</script>");
export const EXE_HEADER = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(256, 0x90)]);
export const GIF_FILE = Buffer.from("GIF89a\x80\x00\x80\x00\x00\x00\x00;", "binary");
