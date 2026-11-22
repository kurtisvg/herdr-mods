// Renders Mermaid diagrams to PNG files in `~/.config/herdr-app/cache/review-panel/`
// via `renderer/render.mjs`, keyed by diagram source, active Herdr theme vars,
// and UI font. Keeps returning the previous rendered image while a redraw is in
// flight so callers never collapse a visible diagram into a spinner box.

import { exec, appHome, settings, theme, checking } from "herdr";
import * as fs from "fs/promises";
import {
  hashText,
  diagramFont,
  diagramThemeVars,
  diagramThemeSignature,
  resolveDiagramEntry,
} from "./diagram.js";

export const CACHE = "cache/review-panel";
const RENDERER = 2; // bump when render.mjs output changes
const SCALE = 2; // PNG device pixels per layout pixel
const rendererDir = () => `${appHome()}/mods/review-panel/renderer`;
const script = () => `${rendererDir()}/render.mjs`;

// Reads a PNG's pixel size from its header, or null if absent or invalid.
async function pngSize(path) {
  try {
    if (!(await fs.exists(path))) return null;
    const b = await fs.readFile(path);
    if (
      b.length < 24 ||
      b[0] !== 0x89 ||
      b[1] !== 0x50 ||
      b[2] !== 0x4e ||
      b[3] !== 0x47
    ) {
      return null;
    }
    const be = (i) =>
      ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const width = be(16);
    const height = be(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

async function isRendererInstalled() {
  const dir = rendererDir();
  try {
    return (
      (await fs.exists(`${dir}/render.mjs`)) &&
      (await fs.exists(`${dir}/node_modules/mermaid/dist/mermaid.min.js`)) &&
      (await fs.exists(`${dir}/node_modules/puppeteer-core/package.json`))
    );
  } catch {
    return false;
  }
}

export class Diagrams {
  constructor() {
    this.known = new Map(); // id -> { pending } | { path, width, height } | { error }
    this.lastByCode = new Map(); // codeHash -> { path, width, height }
    this.lastBySlot = new Map(); // slotKey -> { path, width, height }
    this.missingRenderer = false;
  }

  currentSpec() {
    const s = settings();
    const dark = Boolean(s?.dark);
    const vars = diagramThemeVars(theme());
    const font = diagramFont(s);
    const sig = diagramThemeSignature(dark, vars, font);
    return { dark, vars, font, sig };
  }

  signature() {
    return this.currentSpec().sig;
  }

  id(code, spec = this.currentSpec()) {
    return `${hashText(code)}-${spec.dark ? "d" : "l"}-${spec.sig}-${RENDERER}`;
  }

  evictPath(path) {
    for (const [key, entry] of this.lastByCode) {
      if (entry.path === path) this.lastByCode.delete(key);
    }
    for (const [key, entry] of this.lastBySlot) {
      if (entry.path === path) this.lastBySlot.delete(key);
    }
  }

  // Returns undefined, `{ pending }`, `{ path, width, height, refreshing? }`,
  // or `{ error }`. When a redraw is in flight for a previously drawn diagram
  // (by source hash or optional `slotKey`), keeps returning the previous image
  // with `refreshing: true`.
  get(code, slotKey = null) {
    const current = this.known.get(this.id(code));
    if (current?.path) {
      if (slotKey) this.lastBySlot.set(slotKey, current);
      return current;
    }
    if (this.missingRenderer) return current;
    const previous =
      this.lastByCode.get(hashText(code)) ??
      (slotKey ? this.lastBySlot.get(slotKey) : undefined);
    return resolveDiagramEntry(current, previous);
  }

  // Ensures every non-empty Mermaid block in `codes` has a cached PNG for the
  // active theme and font, batching uncached blocks into one `render.mjs` call.
  async draw(codes, cx) {
    if (checking()) return;
    if (this.busy) {
      this.queued = { codes, cx };
      return;
    }
    this.busy = true;
    try {
      let next = { codes, cx };
      while (next) {
        const { codes: batch, cx: batchCx } = next;
        next = null;
        const spec = this.currentSpec();
        const wanted = new Map();
        for (const code of batch) {
          if (!code?.trim()) continue;
          const id = this.id(code, spec);
          const have = this.known.get(id);
          if (
            have?.path &&
            !(await fs.exists(`${appHome()}/${have.path}`).catch(() => false))
          ) {
            this.known.delete(id);
            this.evictPath(have.path);
          }
          if (!this.known.has(id)) wanted.set(id, code);
        }
        if (wanted.size) await this.render(wanted, spec, batchCx);
        if (this.queued) {
          next = this.queued;
          this.queued = null;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async render(wanted, spec, cx) {
    const installed = await isRendererInstalled();
    this.missingRenderer = !installed;
    if (!installed) {
      cx.notify();
      return;
    }

    const out = `${appHome()}/${CACHE}`;
    const todo = [];
    const codeById = new Map();
    for (const [id, code] of wanted) {
      const size = await pngSize(`${out}/${id}.png`);
      if (size) {
        const entry = {
          path: `${CACHE}/${id}.png`,
          width: size.width / SCALE,
          height: size.height / SCALE,
        };
        this.known.set(id, entry);
        this.lastByCode.set(hashText(code), entry);
      } else {
        this.known.set(id, { pending: true });
        codeById.set(id, code);
        todo.push({ id, code });
      }
    }
    cx.notify();
    if (!todo.length) return;

    const fail = (message) => {
      for (const item of todo) this.known.set(item.id, { error: message });
    };
    const job = `${out}/job-${Date.now()}-${hashText(todo.map((i) => i.id).join())}.json`;
    try {
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(
        job,
        JSON.stringify({
          out,
          dark: spec.dark,
          scale: SCALE,
          vars: spec.vars,
          font: spec.font,
          items: todo,
        }),
      );
      const r = await exec("node", [script(), job], { timeout: 120000 });
      let reply = null;
      try {
        reply = JSON.parse(r.stdout.trim().split("\n").pop());
      } catch {
        reply = null;
      }
      if (!reply) {
        const detail = (r.stderr || r.stdout || "no output").trim().slice(0, 300);
        fail(`the diagram renderer failed (exit ${r.code}): ${detail}`);
      } else if (reply.error) {
        fail(`the diagram renderer could not run: ${reply.error}`);
      } else {
        fail("the renderer returned nothing for this diagram");
        for (const item of reply.results ?? []) {
          if (item.ok) {
            const entry = {
              path: `${CACHE}/${item.id}.png`,
              width: item.width,
              height: item.height,
            };
            this.known.set(item.id, entry);
            const code = codeById.get(item.id);
            if (code) this.lastByCode.set(hashText(code), entry);
          } else {
            this.known.set(item.id, { error: item.error });
          }
        }
      }
    } catch (e) {
      fail(`could not draw: ${String(e?.message ?? e).slice(0, 300)}`);
    } finally {
      try {
        await fs.unlink(job);
      } catch {
        // Job file was never written or already removed.
      }
      cx.notify();
    }
  }
}
