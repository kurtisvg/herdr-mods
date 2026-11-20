// Prepares local picture files for GPUI's `image()`, which only loads files
// inside Herdr's app folder. Each picture is copied into `cache/review-panel/`
// under a content-addressed filename so edits on disk draw under a fresh key,
// and its pixel dimensions are read directly from its header bytes.

import * as fs from "fs/promises";

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32 = (b, i) =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function jpeg(b) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers with no payload length after them.
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
      i += 2;
      continue;
    }
    // Start-of-Frame (SOF) markers hold dimensions. C4, C8, and CC are not SOF.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return { ext: "jpg", width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

const SVG_NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?";
const SVG_VIEWBOX = new RegExp(
  `\\sviewBox\\s*=\\s*["']\\s*${SVG_NUM}[\\s,]+${SVG_NUM}[\\s,]+(${SVG_NUM})[\\s,]+(${SVG_NUM})`,
  "i",
);

function svg(b) {
  const start =
    b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  let head = "";
  for (let i = start; i < Math.min(b.length, 16384); i++) {
    head += String.fromCharCode(b[i]);
  }
  const rest = head.replace(
    /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\b(?:\[[^\]]*\]|[^>\[])*>)+/i,
    "",
  );
  const tag = /^<svg\b[^>]*>/i.exec(rest)?.[0];
  if (!tag) return null;
  const px = (name) => {
    const m = new RegExp(
      `\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(?:px)?\\s*["']`,
      "i",
    ).exec(tag);
    if (!m) return null;
    const n = Number(m[1]);
    return n > 0 && Number.isFinite(n) ? n : null;
  };
  const width = px("width");
  const height = px("height");
  if (width && height) return { ext: "svg", width, height };
  const box = SVG_VIEWBOX.exec(tag);
  if (box) {
    const boxWidth = Number(box[1]);
    const boxHeight = Number(box[2]);
    // A size that is not positive is invalid, so the default applies.
    if (boxWidth > 0 && boxHeight > 0) {
      return { ext: "svg", width: boxWidth, height: boxHeight };
    }
  }
  // Default intrinsic dimensions browsers assign an unsized SVG.
  return { ext: "svg", width: 300, height: 150 };
}

// Reads a picture's format and pixel dimensions from its bytes:
// `{ ext, width, height }`, or null when not PNG, JPEG, GIF, WebP, SVG, or BMP.
export function measure(b) {
  const is = (i, s) => {
    for (let k = 0; k < s.length; k++) {
      if (b[i + k] !== s.charCodeAt(k)) return false;
    }
    return true;
  };
  let m = null;
  if (b.length >= 24 && b[0] === 0x89 && is(1, "PNG")) {
    m = { ext: "png", width: u32be(b, 16), height: u32be(b, 20) };
  } else if (b.length >= 10 && is(0, "GIF8")) {
    m = { ext: "gif", width: u16(b, 6), height: u16(b, 8) };
  } else if (b.length >= 30 && is(0, "RIFF") && is(8, "WEBP")) {
    if (is(12, "VP8 ")) {
      m = { ext: "webp", width: u16(b, 26) & 0x3fff, height: u16(b, 28) & 0x3fff };
    } else if (is(12, "VP8L")) {
      const v = u32(b, 21);
      m = { ext: "webp", width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
    } else if (is(12, "VP8X")) {
      m = { ext: "webp", width: u24(b, 24) + 1, height: u24(b, 27) + 1 };
    }
  } else if (b.length >= 26 && is(0, "BM")) {
    m = { ext: "bmp", width: u32(b, 18), height: Math.abs(u32(b, 22) | 0) };
  } else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    m = jpeg(b);
  } else {
    m = svg(b);
  }
  return m &&
    Number.isFinite(m.width) &&
    Number.isFinite(m.height) &&
    m.width > 0 &&
    m.height > 0
    ? m
    : null;
}

// Fast content signature (cyrb53 plus byte length). Samples evenly past 64 KB.
function sign(b) {
  const step = Math.max(1, Math.ceil(b.length / 65536));
  let x = 0xdeadbeef;
  let y = 0x41c6ce57;
  for (let i = 0; i < b.length; i += step) {
    x = Math.imul(x ^ b[i], 2654435761);
    y = Math.imul(y ^ b[i], 1597334677);
  }
  x = Math.imul(x ^ (x >>> 16), 2246822507) ^ Math.imul(y ^ (y >>> 13), 3266489909);
  y = Math.imul(y ^ (y >>> 16), 2246822507) ^ Math.imul(x ^ (x >>> 13), 3266489909);
  const hash = (4294967296 * (2097151 & y) + (x >>> 0))
    .toString(16)
    .padStart(14, "0");
  return `${hash}-${b.length.toString(36)}`;
}

// Copies the local picture at `path` into `cache` if needed and resolves with
// `{ file, width, height }` or `{ error }`.
export async function ready(path, cache) {
  let bytes;
  try {
    if (!(await fs.exists(path))) return { error: "This file isn't there." };
    bytes = await fs.readFile(path);
  } catch (e) {
    return { error: `Cannot read this file: ${String(e?.message ?? e)}` };
  }
  const m = measure(bytes);
  if (!m) {
    return {
      error: "This file isn't a PNG, JPEG, GIF, WebP, SVG or BMP picture.",
    };
  }
  const file = `pic-${sign(bytes)}.${m.ext}`;
  try {
    if (!(await fs.exists(`${cache}/${file}`))) {
      await fs.mkdir(cache, { recursive: true });
      await fs.writeFile(`${cache}/${file}`, bytes);
    }
  } catch (e) {
    return { error: `Cannot write to ${cache}: ${String(e?.message ?? e)}` };
  }
  return { file, width: m.width, height: m.height };
}
