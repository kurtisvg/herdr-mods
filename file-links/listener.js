// Hidden floating listener that bridges `herdr-app do file-links.open` into
// Herdr's right-hand Files panel (`review-panel` or the drop-in `files` role).

import { div } from "gpui-kit";
import {
  appHome,
  checking,
  layout,
  nextCommand,
  readTextFile,
  run,
  setShared,
} from "herdr";
import {
  SHARED_OPEN,
  positiveIntOrNull,
  resolvePanelTarget,
} from "./path.js";

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export class Listener {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command !== "open") continue;
        try {
          await this.handleOpen();
        } catch (err) {
          console.log(`file-links: failed to open file: ${err}`);
        }
      }
    });
  }

  async handleOpen() {
    const requestPath = `${appHome()}/data/file-links/request.json`;
    const raw = await readTextFile(requestPath);
    if (!raw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data.path !== "string" || !data.path.trim()) return;

    const now = Date.now();
    const request = {
      id:
        typeof data.id === "string" && data.id
          ? data.id
          : `${now}-${Math.random().toString(16).slice(2, 8)}`,
      path: data.path.trim(),
      realpath:
        typeof data.realpath === "string" && data.realpath
          ? data.realpath
          : null,
      line: positiveIntOrNull(data.line),
      col: positiveIntOrNull(data.col),
      at: now,
    };

    const rootLayout = layout();
    const target = resolvePanelTarget(rootLayout);

    if (target?.kind === "review-panel") {
      setShared("review-panel.mode", "files");
    }
    setShared(SHARED_OPEN, request);

    if (target?.stackId && target?.childId) {
      run("layout.select", { stack: target.stackId, child: target.childId });
    }
    if (target?.panelId) {
      run("layout.show", { id: target.panelId });
    } else if (findNode(rootLayout, "panel")) {
      run("layout.show", { id: "panel" });
    }
  }

  // Render an empty element so the floating block stays hidden.
  render() {
    return div();
  }
}
