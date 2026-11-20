// Pure helpers shared by the file-links listener and drop-in Files panel.
// Kept free of Herdr host imports so `node --test` can exercise them directly.

export const SHARED_OPEN = "file-links.open";
export const FRESH_MS = 5000;

export function isAbsolutePath(path) {
  return typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path));
}

export function normalizePath(path) {
  if (typeof path !== "string" || !path) return "";
  const windowsDrive = path.match(/^([A-Za-z]:)[\\/](.*)$/);
  const slashNorm = path.replace(/\\/g, "/");
  const prefix = windowsDrive
    ? `${windowsDrive[1]}/`
    : slashNorm.startsWith("/")
      ? "/"
      : "";
  const body = windowsDrive ? windowsDrive[2].replace(/\\/g, "/") : slashNorm;

  const parts = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push("..");
      }
      continue;
    }
    parts.push(part);
  }
  return prefix + parts.join("/");
}

// Maps an incoming open request to a path relative to `root` when the file sits
// inside `root` (checking both `path` and `realpath` to handle symlinks), or
// returns the normalized absolute path when it sits outside `root`.
export function toPanelPath(request, root) {
  const raw = normalizePath(request?.path ?? "");
  if (!raw) return "";
  const normRoot = normalizePath(root ?? "").replace(/\/+$/, "");
  if (!normRoot) return raw;

  const prefix = normRoot === "/" ? "/" : `${normRoot}/`;
  const candidates = [raw];
  if (request?.realpath) {
    const real = normalizePath(request.realpath);
    if (real && real !== raw) candidates.push(real);
  }
  for (const candidate of candidates) {
    if (candidate.startsWith(prefix) && candidate.length > prefix.length) {
      return candidate.slice(prefix.length);
    }
  }
  return raw;
}

export function diskPath(root, path) {
  if (!path) return root ?? "";
  if (isAbsolutePath(path)) return path;
  if (!root) return path;
  return `${root.replace(/\/+$/, "")}/${path}`;
}

export function displayPath(path, homeDir) {
  if (!path) return "";
  if (!homeDir) return path;
  const cleanHome = homeDir.replace(/\/+$/, "");
  if (cleanHome && path.startsWith(`${cleanHome}/`)) {
    return `~/${path.slice(cleanHome.length + 1)}`;
  }
  return path;
}

export function positiveIntOrNull(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n >= 1 ? n : null;
}

export function isFreshRequest(request, now = Date.now()) {
  if (!request || typeof request !== "object") return false;
  if (typeof request.id !== "string" || !request.id) return false;
  if (typeof request.path !== "string" || !request.path) return false;
  if (typeof request.at !== "number" || !Number.isFinite(request.at)) return false;
  const age = now - request.at;
  return age >= -FRESH_MS && age <= FRESH_MS;
}

// Converts a 1-based line and column into a UTF-16 character offset for
// EditorState.set_selected_range().
export function lineToOffset(text, line, col = 1) {
  if (typeof text !== "string" || !text.length) return 0;
  const targetLine = Math.max(1, positiveIntOrNull(line) ?? 1);
  const targetCol = Math.max(1, positiveIntOrNull(col) ?? 1);

  let currentLine = 1;
  let lineStart = 0;
  for (let i = 0; i < text.length && currentLine < targetLine; i++) {
    if (text.charCodeAt(i) === 10) {
      currentLine += 1;
      lineStart = i + 1;
    }
  }

  let lineEnd = text.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = text.length;
  if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) {
    lineEnd -= 1;
  }

  const maxColOffset = lineEnd - lineStart;
  return lineStart + Math.min(targetCol - 1, maxColOffset);
}

// Finds the side-panel block that can display opened files (`review-panel` or
// `file-links` with `role: "files"`), along with the panel node to show and the
// stack child to select.
export function resolvePanelTarget(rootNode) {
  if (!rootNode || typeof rootNode !== "object") return null;

  const matches = [];
  function walk(node, ctx) {
    if (!node || typeof node !== "object") return;
    const panelId = node.id === "panel" ? "panel" : ctx.panelId;
    const inPanel = ctx.inPanel || node.id === "panel";
    const mod = node.content?.mod;
    const props = node.content?.props ?? {};

    if (mod === "file-links" && props.role === "files") {
      matches.push({
        kind: "files",
        panelId: panelId ?? node.id ?? null,
        stackId: ctx.stackId,
        childId: ctx.childId,
        inPanel,
        active: ctx.active,
      });
    } else if (
      mod === "review-panel" &&
      props.role !== "tabs" &&
      props.role !== "viewer" &&
      !props.file
    ) {
      matches.push({
        kind: "review-panel",
        panelId: panelId ?? node.id ?? null,
        stackId: ctx.stackId,
        childId: ctx.childId,
        inPanel,
        active: ctx.active,
      });
    }

    const children = node.children ?? [];
    for (const child of children) {
      const isStack = node.type === "stack";
      const nextStackId = isStack ? (node.id ?? ctx.stackId) : ctx.stackId;
      const nextChildId = isStack ? (child?.id ?? ctx.childId) : ctx.childId;
      const childActive =
        ctx.active &&
        (!isStack || (node.active ?? children[0]?.id) === child?.id);
      walk(child, {
        panelId,
        inPanel,
        stackId: nextStackId,
        childId: nextChildId,
        active: childActive,
      });
    }
  }

  walk(rootNode, {
    panelId: null,
    inPanel: false,
    stackId: null,
    childId: null,
    active: true,
  });

  if (!matches.length) return null;
  matches.sort(
    (a, b) =>
      Number(b.inPanel) - Number(a.inPanel) ||
      Number(b.active) - Number(a.active),
  );
  const { kind, panelId, stackId, childId } = matches[0];
  return { kind, panelId, stackId, childId };
}
