// Run with: node --test review-panel/test/picture.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { measure } from "../picture.js";

test("measure parses PNG, JPEG, GIF, WebP, BMP, and SVG headers while rejecting non-images", () => {
  // PNG (320x200)
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0, 0, 1, 0x40], 16);
  png.set([0, 0, 0, 0xc8], 20);
  assert.deepEqual(measure(png), { ext: "png", width: 320, height: 200 });

  // GIF (64x48)
  const gif = Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 64, 0, 48, 0,
  ]);
  assert.deepEqual(measure(gif), { ext: "gif", width: 64, height: 48 });

  // JPEG with APP0 segment followed by SOF0 (width 512, height 256)
  const jpg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b,
    0x08, 0x01, 0x00, 0x02, 0x00,
  ]);
  assert.deepEqual(measure(jpg), { ext: "jpg", width: 512, height: 256 });
  // Corrupt JPEG segment with invalid length < 2 returns null cleanly.
  const badJpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
  assert.equal(measure(badJpg), null);

  // WebP VP8 lossy (30-byte header: 320x240)
  const vp8 = new Uint8Array(30);
  vp8.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  vp8.set([0x56, 0x50, 0x38, 0x20], 12);
  vp8.set([0x40, 0x01, 0xf0, 0x00], 26);
  assert.deepEqual(measure(vp8), { ext: "webp", width: 320, height: 240 });

  // WebP VP8L (10x20 => (9) | (19 << 14))
  const vp8l = new Uint8Array(30);
  vp8l.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  vp8l.set([0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f], 12);
  const packed = 9 | (19 << 14);
  vp8l.set([packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, 0], 21);
  assert.deepEqual(measure(vp8l), { ext: "webp", width: 10, height: 20 });

  // WebP VP8X (100x80 => 99, 79)
  const vp8x = new Uint8Array(30);
  vp8x.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  vp8x.set([0x56, 0x50, 0x38, 0x58], 12);
  vp8x.set([99, 0, 0], 24);
  vp8x.set([79, 0, 0], 27);
  assert.deepEqual(measure(vp8x), { ext: "webp", width: 100, height: 80 });

  // Top-down BMP with negative signed height (-32 => 32)
  const bmp = new Uint8Array(26);
  bmp.set([0x42, 0x4d]);
  bmp.set([16, 0, 0, 0], 18);
  bmp.set([0xe0, 0xff, 0xff, 0xff], 22);
  assert.deepEqual(measure(bmp), { ext: "bmp", width: 16, height: 32 });

  // SVG: explicit dimensions, viewBox, and default fallback
  const toBytes = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  assert.deepEqual(measure(toBytes('<svg width="24px" height="24px"></svg>')), {
    ext: "svg",
    width: 24,
    height: 24,
  });
  assert.deepEqual(
    measure(
      toBytes(
        '\xef\xbb\xbf<?xml version="1.0"?><!-- icon --><svg viewBox="0 0 1.2e+2 80"></svg>',
      ),
    ),
    { ext: "svg", width: 120, height: 80 },
  );
  assert.deepEqual(measure(toBytes("<svg></svg>")), {
    ext: "svg",
    width: 300,
    height: 150,
  });

  // HTML, JS, or unclosed DOCTYPE headers are rejected in linear time.
  assert.equal(
    measure(toBytes('<!doctype html><html><body><svg width="10" height="10"></svg></body></html>')),
    null,
  );
  assert.equal(measure(toBytes("const tag = /<svg\\b[^>]*>/;")), null);
  assert.equal(measure(toBytes("<!DOCTYPE " + "[a]".repeat(60))), null);
  assert.equal(measure(toBytes('<svg viewBox="0 0 1e400 10"></svg>')), null);
  // A viewBox size that is not positive gives the default size.
  assert.deepEqual(measure(toBytes('<svg viewBox="0 0 -5 10"></svg>')), {
    ext: "svg",
    width: 300,
    height: 150,
  });
});
