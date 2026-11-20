// Caches local markdown pictures inside `~/.config/herdr-app/cache/review-panel/`
// so GPUI's `image()` can draw them. Web URLs and remote files stay as text.
// Deleting the cache folder at any time is safe.

import { appHome } from "herdr";
import { ready } from "./picture.js";

export const CACHE = "cache/review-panel";
const AGAIN = 10000; // minimum ms before the known pictures are read again

export class Pictures {
  constructor() {
    this.known = new Map(); // path -> { pending } | { file, width, height } | { error }
    this.looked = 0; // when the known pictures were last read again (ms)
  }

  // Returns undefined, `{ pending }`, `{ file, width, height }`, or `{ error }`.
  get(path) {
    return this.known.get(path);
  }

  // Makes a cached copy for each path in `paths`. Pictures that are already
  // known are read again at most once every 10 seconds.
  async draw(paths, cx) {
    if (this.busy) {
      this.queued = { paths, cx };
      return;
    }
    this.busy = true;
    try {
      let next = { paths, cx };
      while (next) {
        const { paths: batch, cx: batchCx } = next;
        next = null;
        const cacheDir = `${appHome()}/${CACHE}`;
        const again = Date.now() - this.looked >= AGAIN;
        for (const path of new Set(batch)) {
          const had = this.known.get(path);
          if (had && !again) continue;
          if (!had) this.known.set(path, { pending: true });
          const now = await ready(path, cacheDir);
          if (had && had.file === now.file && had.error === now.error) continue;
          this.known.set(path, now);
          batchCx.notify();
        }
        if (again) this.looked = Date.now();
        if (this.queued) {
          next = this.queued;
          this.queued = null;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
