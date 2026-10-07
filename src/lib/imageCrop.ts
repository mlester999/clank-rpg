"use client";

/**
 * Browser-side prep for a profile photo: centre-crop to a square, scale down to at most `maxSide` px and re-encode
 * (which also drops EXIF/GPS metadata). The server still validates the result from its bytes — this only makes sure the
 * admin uploads a small, square, clean image instead of a 12 MB camera original.
 */
export const PHOTO_OUTPUT_SIDE = 512;
export const PHOTO_MIN_SIDE = 64;

export interface CroppedPhoto {
  blob: Blob;
  width: number;
  height: number;
  /** Object URL for previewing the result; revoke it when done. */
  previewUrl: string;
}

export class PhotoPrepError extends Error {}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall through to <img> decoding
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } catch {
    throw new PhotoPrepError("That file could not be read as an image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function cropToSquare(file: File, maxSide = PHOTO_OUTPUT_SIDE): Promise<CroppedPhoto> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new PhotoPrepError("Choose a PNG, JPEG or WebP image.");
  if (file.size > 25 * 1024 * 1024) throw new PhotoPrepError("That file is too large to prepare (25 MB max).");
  const img = await decode(file);
  try {
    const side = Math.min(img.width, img.height);
    if (side < PHOTO_MIN_SIDE) throw new PhotoPrepError(`The image must be at least ${PHOTO_MIN_SIDE}×${PHOTO_MIN_SIDE} pixels.`);
    const out = Math.min(maxSide, side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoPrepError("Your browser cannot prepare images.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img.source, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
    // WebP where the browser can encode it (smaller), otherwise it falls back to PNG on its own.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!blob) throw new PhotoPrepError("Could not prepare that image.");
    return { blob, width: out, height: out, previewUrl: URL.createObjectURL(blob) };
  } finally {
    img.close();
  }
}
