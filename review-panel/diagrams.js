// Renders Mermaid diagrams to PNG files in `~/.config/herdr-app/cache/review-panel/`
// via `renderer/render.mjs`, keyed by diagram source and light/dark theme.
// When the renderer or its npm packages are not installed, `render()` sets
// `missingRenderer` and `get()` returns undefined, so callers can show why.

import { exec, appHome, settings } from "herdr";
import * as fs from "fs/promises";

export const CACHE = "cache/review-panel";
const RENDERER = 1; // bump when render.mjs output changes
const SCALE = 2; // PNG device pixels per layout pixel
const rendererDir = () => `${appHome()}/mods/review-panel/renderer`;
const script = () => `${rendererDir()}/render.mjs`;

// cyrb53: short stable content key for diagram text.
function hash(text) {
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
    this.missingRenderer = false;
  }

  id(code, dark = Boolean(settings().dark)) {
    return `${hash(code)}-${dark ? "d" : "l"}${RENDERER}`;
  }

  // Returns undefined, `{ pending }`, `{ path, width, height }`, or `{ error }`.
  get(code) {
    return this.known.get(this.id(code));
  }

  // Ensures every non-empty Mermaid block in `codes` has a cached PNG for the
  // active theme, batching uncached blocks into one `render.mjs` invocation.
  async draw(codes, cx) {
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
        const dark = Boolean(settings().dark);
        const wanted = new Map();
        for (const code of batch) {
          if (!code?.trim()) continue;
          const id = this.id(code, dark);
          const have = this.known.get(id);
          if (
            have?.path &&
            !(await fs.exists(`${appHome()}/${have.path}`).catch(() => false))
          ) {
            this.known.delete(id);
          }
          if (!this.known.has(id)) wanted.set(id, code);
        }
        if (wanted.size) await this.render(wanted, dark, batchCx);
        if (this.queued) {
          next = this.queued;
          this.queued = null;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async render(wanted, dark, cx) {
    const installed = await isRendererInstalled();
    this.missingRenderer = !installed;
    if (!installed) {
      cx.notify();
      return;
    }

    const out = `${appHome()}/${CACHE}`;
    const todo = [];
    for (const [id, code] of wanted) {
      const size = await pngSize(`${out}/${id}.png`);
      if (size) {
        this.known.set(id, {
          path: `${CACHE}/${id}.png`,
          width: size.width / SCALE,
          height: size.height / SCALE,
        });
      } else {
        this.known.set(id, { pending: true });
        todo.push({ id, code });
      }
    }
    cx.notify();
    if (!todo.length) return;

    const fail = (message) => {
      for (const item of todo) this.known.set(item.id, { error: message });
    };
    const job = `${out}/job-${Date.now()}-${hash(todo.map((i) => i.id).join())}.json`;
    try {
      await fs.mkdir(out, { recursive: true });
      await fs.writeFile(job, JSON.stringify({ out, dark, scale: SCALE, items: todo }));
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
          this.known.set(
            item.id,
            item.ok
              ? {
                  path: `${CACHE}/${item.id}.png`,
                  width: item.width,
                  height: item.height,
                }
              : { error: item.error },
          );
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
