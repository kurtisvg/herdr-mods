// Run with: node --test review-panel/test/diagram.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_VIEW,
  normalizeHex,
  diagramFont,
  diagramThemeVars,
  diagramThemeSignature,
  clampZoom,
  formatZoom,
  isDefaultView,
  computeDiagramLayout,
  zoomAtPoint,
  zoomBy,
  panBy,
  resolveDiagramEntry,
} from "../diagram.js";

test("normalizeHex accepts 3/6 hex, strips alpha from 4/8 hex, and rejects invalid values", () => {
  assert.equal(normalizeHex("#ABC"), "#abc");
  assert.equal(normalizeHex(" #1A2b3C "), "#1a2b3c");
  assert.equal(normalizeHex("#1a2b3c80"), "#1a2b3c");
  assert.equal(normalizeHex("#abc8"), "#abc");
  assert.equal(normalizeHex("red"), null);
  assert.equal(normalizeHex("#12345"), null);
  assert.equal(normalizeHex(null), null);
});

test("diagramFont builds a fallback stack from Herdr ui_font_family", () => {
  assert.match(diagramFont({}), /^-apple-system,/);
  assert.match(diagramFont({ ui_font_family: "Geist" }), /^"Geist", -apple-system,/);
  assert.equal(
    diagramFont({ ui_font_family: "Inter, sans-serif" }),
    "Inter, sans-serif",
  );
  assert.match(diagramFont({ ui_font_family: 'Geist"Test' }), /^"GeistTest", /);
});

test("diagramThemeVars maps Herdr theme colors to Mermaid base themeVariables", () => {
  assert.equal(diagramThemeVars(null), null);
  assert.equal(diagramThemeVars({}), null);

  const vars = diagramThemeVars({
    background: "#111214",
    surface: "#181a1f",
    raised: "#22252c",
    chrome: "#14161a88",
    popover: "#252932",
    hover: "#2c313c",
    border: "#343946",
    foreground: "#e6edf3",
    muted: "#9aa5b1",
    accent: "#58a6ff",
  });
  assert.equal(vars.background, "#181a1f");
  assert.equal(vars.primaryColor, "#22252c");
  assert.equal(vars.primaryTextColor, "#e6edf3");
  assert.equal(vars.primaryBorderColor, "#58a6ff");
  assert.equal(vars.secondaryColor, "#14161a"); // alpha stripped
  assert.equal(vars.lineColor, "#9aa5b1");
  assert.equal(vars.noteBkgColor, "#252932");
  assert.equal(vars.activationBkgColor, "#2c313c");
});

test("diagramThemeSignature is stable across key order and sensitive to theme changes", () => {
  const sigA = diagramThemeSignature(
    true,
    { primaryColor: "#222222", textColor: "#eeeeee" },
    '"Geist", sans-serif',
  );
  const sigB = diagramThemeSignature(
    true,
    { textColor: "#eeeeee", primaryColor: "#222222" },
    '"Geist", sans-serif',
  );
  const sigLight = diagramThemeSignature(
    false,
    { primaryColor: "#222222", textColor: "#eeeeee" },
    '"Geist", sans-serif',
  );
  const sigOtherFont = diagramThemeSignature(
    true,
    { primaryColor: "#222222", textColor: "#eeeeee" },
    '"Inter", sans-serif',
  );
  const sigOtherColor = diagramThemeSignature(
    true,
    { primaryColor: "#333333", textColor: "#eeeeee" },
    '"Geist", sans-serif',
  );

  assert.equal(sigA, sigB);
  assert.notEqual(sigA, sigLight);
  assert.notEqual(sigA, sigOtherFont);
  assert.notEqual(sigA, sigOtherColor);
});

test("clampZoom, formatZoom, and isDefaultView handle bounds and defaults", () => {
  assert.equal(clampZoom(0.01), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(formatZoom(1.254), "125%");
  assert.equal(isDefaultView(DEFAULT_VIEW), true);
  assert.equal(isDefaultView({ zoom: 1, x: 0.2, y: -0.2 }), true);
  assert.equal(isDefaultView({ zoom: 1.25, x: 0, y: 0 }), false);
  assert.equal(isDefaultView({ zoom: 1, x: 10, y: 0 }), false);
});

test("computeDiagramLayout fits inline width, lightbox height, and clamps pan", () => {
  const wide = { width: 1000, height: 500 };
  const inline = computeDiagramLayout(wide, { width: 532 }, DEFAULT_VIEW);
  // innerW = 532 - 32 = 500 => baseScale = 0.5
  assert.equal(inline.baseScale, 0.5);
  assert.equal(inline.width, 500);
  assert.equal(inline.height, 250);
  assert.equal(inline.viewportHeight, 250 + 16 + 44);

  const lightbox = computeDiagramLayout(
    { width: 600, height: 1200 },
    { width: 800, height: 648 },
    DEFAULT_VIEW,
    { fitHeight: true },
  );
  // innerH = 648 - 48 = 600 => baseScale = 0.5
  assert.equal(lightbox.baseScale, 0.5);
  assert.equal(lightbox.width, 300);
  assert.equal(lightbox.height, 600);

  const panned = computeDiagramLayout(
    { width: 400, height: 200 },
    { width: 400, height: 300 },
    { zoom: 2, x: 99999, y: -99999 },
    { fitHeight: true },
  );
  assert.ok(panned.left <= panned.viewportWidth - 48 + 1e-6);
  assert.ok(panned.top + panned.height >= 48 - 1e-6);
});

test("zoomAtPoint keeps the cursor focal point stationary during zoom", () => {
  const viewport = { width: 400, height: 300 };
  const point = { x: 300, y: 90 }; // offset (+100, -60) from center
  const start = { zoom: 1, x: 0, y: 0 };
  const zoomed = zoomAtPoint(start, 2, point, viewport);

  assert.equal(zoomed.zoom, 2);
  // At 2x zoom around (+100, -60), center shifts by (-100, +60).
  assert.equal(zoomed.x, -100);
  assert.equal(zoomed.y, 60);

  const stepped = zoomBy(zoomed, 0.5, point, viewport);
  assert.equal(stepped.zoom, 1);
  assert.equal(stepped.x, 0);
  assert.equal(stepped.y, 0);

  const shifted = panBy(start, 24, -12);
  assert.deepEqual(shifted, { zoom: 1, x: 24, y: -12 });
});

test("zoomAtPoint keeps cursor stationary on an inline card with asymmetric padding", () => {
  const diagram = { width: 400, height: 200 };
  const before = computeDiagramLayout(diagram, { width: 432 }, DEFAULT_VIEW);
  const viewport = {
    width: before.viewportWidth,
    height: before.viewportHeight,
    center: before.center,
  };
  const cursor = { x: 180, y: 90 };
  const normX = (cursor.x - before.left) / before.width;
  const normY = (cursor.y - before.top) / before.height;

  const zoomedState = zoomAtPoint(DEFAULT_VIEW, 2, cursor, viewport);
  const after = computeDiagramLayout(diagram, { width: 432 }, zoomedState);

  assert.ok(Math.abs(after.left + normX * after.width - cursor.x) < 1e-6);
  assert.ok(Math.abs(after.top + normY * after.height - cursor.y) < 1e-6);
});

test("resolveDiagramEntry keeps previous rendered diagram while redraw is in flight", () => {
  const prev = { path: "cache/review-panel/old.png", width: 400, height: 200 };
  const fresh = { path: "cache/review-panel/new.png", width: 420, height: 210 };

  // Redraw pending: keep previous image and mark refreshing.
  assert.deepEqual(resolveDiagramEntry({ pending: true }, prev), {
    ...prev,
    pending: true,
    refreshing: true,
  });

  // Theme just switched before draw() marked pending: still keep previous image.
  assert.deepEqual(resolveDiagramEntry(undefined, prev), {
    ...prev,
    pending: false,
    refreshing: true,
  });

  // Fresh render finished: swap to new image.
  assert.deepEqual(resolveDiagramEntry(fresh, prev), fresh);

  // Syntax error on new code: surface the error instead of hiding it.
  assert.deepEqual(resolveDiagramEntry({ error: "parse error" }, prev), {
    error: "parse error",
  });

  // First draw with no previous image: return pending/undefined as-is.
  assert.deepEqual(resolveDiagramEntry({ pending: true }, undefined), {
    pending: true,
  });
  assert.equal(resolveDiagramEntry(undefined, undefined), undefined);
});
