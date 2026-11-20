// If Herdr's `mods/review-panel` is a symlink to this folder, Herdr does not
// watch edits through the symlink: run `./plugin.sh reload review-panel` after
// changing a file.
//
// `review-panel` serves three roles from one mod:
//   - Default (no role): the Files | Changes | Comments side panel (`panel.js`).
//   - `props.role === "tabs"`: top tab bar with Files | Changes | Comments
//     buttons (`tabs.js`).
//   - `props.role === "viewer"` or `props.file`: standalone markdown viewer in
//     a pane or tab (`viewer.js`).

import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { Tabs } from "./tabs.js";
import { Viewer } from "./viewer.js";

export default class Review extends View {
  init(p, cx) {
    const cfg = props() ?? {};
    if (cfg.role === "tabs") this.part = new Tabs();
    else if (cfg.role === "viewer" || Boolean(cfg.file)) this.part = new Viewer();
    else this.part = new Panel();
    this.part.init(p, cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  async close(cx) {
    await this.part.close?.(cx);
  }
}
