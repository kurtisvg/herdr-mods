// Pure helpers for Mermaid diagram theming, cache keys, and zoom/pan geometry.
// Kept free of `herdr` and `gpui-kit` imports so Node unit tests can import it.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 1.25;
export const PAN_STEP = 48;
export const DEFAULT_VIEW = Object.freeze({ zoom: 1, x: 0, y: 0 });

const FALLBACK_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const INLINE_PAD_X = 16;
const INLINE_PAD_TOP = 16;
const INLINE_PAD_BOTTOM = 44; // reserves space for the floating control bar
const INLINE_MIN_HEIGHT = 120;
const LIGHTBOX_PAD = 24;

// cyrb53: short stable content key for diagram source and theme fingerprints.
export function hashText(text) {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, "0");
}

// Normalizes a CSS hex color to an opaque `#rgb` or `#rrggbb` string so Mermaid's
// color derivations never choke on `#rrggbbaa` alpha channels.
export function normalizeHex(color) {
  if (typeof color !== "string") return null;
  const s = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(s) || /^#[0-9a-f]{3}$/i.test(s)) {
    return s.toLowerCase();
  }
  if (/^#[0-9a-f]{8}$/i.test(s)) return s.slice(0, 7).toLowerCase();
  if (/^#[0-9a-f]{4}$/i.test(s)) return s.slice(0, 4).toLowerCase();
  return null;
}

// Builds a CSS font-family stack from Herdr's `settings()` object.
export function diagramFont(settings) {
  const raw =
    typeof settings?.ui_font_family === "string"
      ? settings.ui_font_family.trim()
      : "";
  if (!raw) return FALLBACK_FONT;
  if (raw.includes(",")) return raw;
  const clean = raw.replace(/["\\]/g, "");
  return clean ? `"${clean}", ${FALLBACK_FONT}` : FALLBACK_FONT;
}

// Maps Herdr's `theme()` tokens to Mermaid `base` themeVariables.
export function diagramThemeVars(theme) {
  if (!theme || typeof theme !== "object") return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const hex = normalizeHex(theme[key]);
      if (hex) return hex;
    }
    return null;
  };

  const pairs = [
    ["background", pick("surface", "background")],
    ["primaryColor", pick("raised", "surface")],
    ["primaryTextColor", pick("foreground")],
    ["primaryBorderColor", pick("accent", "border")],
    ["secondaryColor", pick("chrome", "surface")],
    ["secondaryTextColor", pick("foreground")],
    ["secondaryBorderColor", pick("border")],
    ["tertiaryColor", pick("background", "surface")],
    ["tertiaryTextColor", pick("foreground")],
    ["tertiaryBorderColor", pick("border")],
    ["lineColor", pick("muted", "dim")],
    ["textColor", pick("foreground")],
    ["mainBkg", pick("raised", "surface")],
    ["nodeBorder", pick("border")],
    ["clusterBkg", pick("chrome", "surface")],
    ["clusterBorder", pick("border")],
    ["defaultLinkColor", pick("muted", "dim")],
    ["titleColor", pick("foreground")],
    ["edgeLabelBackground", pick("surface", "background")],
    ["actorBkg", pick("raised", "surface")],
    ["actorBorder", pick("border")],
    ["actorTextColor", pick("foreground")],
    ["actorLineColor", pick("border")],
    ["signalColor", pick("foreground")],
    ["signalTextColor", pick("foreground")],
    ["labelBoxBkgColor", pick("surface", "background")],
    ["labelBoxBorderColor", pick("border")],
    ["labelTextColor", pick("foreground")],
    ["loopTextColor", pick("foreground")],
    ["noteBkgColor", pick("popover", "surface")],
    ["noteBorderColor", pick("accent", "border")],
    ["noteTextColor", pick("foreground")],
    ["activationBkgColor", pick("hover", "raised")],
    ["activationBorderColor", pick("accent", "border")],
    ["sectionBkgColor", pick("surface", "background")],
    ["altSectionBkgColor", pick("chrome", "surface")],
    ["gridColor", pick("border")],
  ];

  const vars = {};
  let count = 0;
  for (const [name, value] of pairs) {
    if (!value) continue;
    vars[name] = value;
    count += 1;
  }
  return count > 0 ? vars : null;
}

// Produces a deterministic short fingerprint for a render theme configuration.
export function diagramThemeSignature(dark, vars, font) {
  const entries = vars
    ? Object.keys(vars)
        .sort()
        .map((k) => `${k}=${vars[k]}`)
        .join(";")
    : "";
  return hashText(`${dark ? "d" : "l"}|${font ?? ""}|${entries}`);
}

export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

export function formatZoom(zoom) {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}

export function isDefaultView(state) {
  if (!state) return true;
  return (
    Math.abs((state.zoom ?? 1) - 1) < 1e-4 &&
    Math.abs(state.x ?? 0) < 0.5 &&
    Math.abs(state.y ?? 0) < 0.5
  );
}

// Computes viewport dimensions, base fit scale, scaled image size, and clamped
// image coordinates for either an inline card or a fixed-size lightbox.
export function computeDiagramLayout(diagram, viewport, state = DEFAULT_VIEW, opts = {}) {
  const fitHeight = Boolean(opts.fitHeight);
  const srcW = Math.max(1, diagram?.width ?? 1);
  const srcH = Math.max(1, diagram?.height ?? 1);
  const viewW = Math.max(120, Math.round(viewport?.width ?? 320));

  const padX = fitHeight ? LIGHTBOX_PAD : INLINE_PAD_X;
  const padTop = fitHeight ? LIGHTBOX_PAD : INLINE_PAD_TOP;
  const padBottom = fitHeight ? LIGHTBOX_PAD : INLINE_PAD_BOTTOM;
  const innerW = Math.max(40, viewW - padX * 2);

  let baseScale;
  let viewH;
  if (fitHeight) {
    viewH = Math.max(120, Math.round(viewport?.height ?? 320));
    const innerH = Math.max(40, viewH - padTop - padBottom);
    baseScale = Math.min(1, innerW / srcW, innerH / srcH);
  } else {
    baseScale = Math.min(1, innerW / srcW);
    viewH = Math.max(
      INLINE_MIN_HEIGHT,
      Math.round(srcH * baseScale) + padTop + padBottom,
    );
  }

  const zoom = clampZoom(state?.zoom ?? 1);
  const scale = baseScale * zoom;
  const width = Math.max(1, srcW * scale);
  const height = Math.max(1, srcH * scale);

  const minVisible = Math.min(48, width / 2, height / 2);
  const maxX = Math.max(0, (viewW + width) / 2 - minVisible);
  const maxY = Math.max(0, (viewH + height) / 2 - minVisible);
  const x = Math.max(-maxX, Math.min(maxX, Number.isFinite(state?.x) ? state.x : 0));
  const y = Math.max(-maxY, Math.min(maxY, Number.isFinite(state?.y) ? state.y : 0));

  const centerX = viewW / 2;
  const centerY = fitHeight ? viewH / 2 : padTop + (viewH - padTop - padBottom) / 2;
  const left = centerX - width / 2 + x;
  const top = centerY - height / 2 + y;

  return {
    viewportWidth: viewW,
    viewportHeight: viewH,
    center: { x: centerX, y: centerY },
    baseScale,
    zoom,
    width,
    height,
    x,
    y,
    left,
    top,
  };
}

// Adjusts zoom while keeping `point` (viewport-relative) anchored in place.
export function zoomAtPoint(state, nextZoom, point, viewport) {
  const prevZoom = clampZoom(state?.zoom ?? 1);
  const zoom = clampZoom(nextZoom);
  const prevX = Number.isFinite(state?.x) ? state.x : 0;
  const prevY = Number.isFinite(state?.y) ? state.y : 0;
  if (zoom === prevZoom) return { zoom, x: prevX, y: prevY };

  const viewW = Math.max(1, viewport?.width ?? 1);
  const viewH = Math.max(1, viewport?.height ?? 1);
  const originX = Number.isFinite(viewport?.center?.x) ? viewport.center.x : viewW / 2;
  const originY = Number.isFinite(viewport?.center?.y) ? viewport.center.y : viewH / 2;
  const px = Number.isFinite(point?.x) ? point.x : originX;
  const py = Number.isFinite(point?.y) ? point.y : originY;
  const cx = px - originX;
  const cy = py - originY;
  const ratio = zoom / prevZoom;

  return {
    zoom,
    x: cx - (cx - prevX) * ratio,
    y: cy - (cy - prevY) * ratio,
  };
}

export function zoomBy(state, factor, point, viewport) {
  const prevZoom = clampZoom(state?.zoom ?? 1);
  return zoomAtPoint(state, prevZoom * factor, point, viewport);
}

export function panBy(state, dx, dy) {
  return {
    zoom: clampZoom(state?.zoom ?? 1),
    x: (Number.isFinite(state?.x) ? state.x : 0) + dx,
    y: (Number.isFinite(state?.y) ? state.y : 0) + dy,
  };
}

// Resolves the diagram entry to render, falling back to a previous rendered
// diagram while a redraw is in flight instead of collapsing to a spinner.
export function resolveDiagramEntry(current, previous) {
  if (current?.path || current?.error) return current;
  if (previous?.path) {
    return {
      path: previous.path,
      width: previous.width,
      height: previous.height,
      pending: Boolean(current?.pending),
      refreshing: true,
    };
  }
  return current;
}
