// If Herdr's `mods/file-links` is a symlink to this folder, Herdr does not
// watch edits behind the link: run `./plugin.sh reload file-links` after
// changing a file here.
//
// `file-links` serves two roles from one mod:
//   - Default (no role): hidden floating listener that receives
//     `herdr-app do file-links.open`, opens the right panel to Files, and
//     publishes the target via `shared("file-links.open")`.
//   - `props.role === "files"`: drop-in replacement for Herdr's shipped `files`
//     panel that also opens files published to `shared("file-links.open")`.

import { View } from "gpui-kit";
import { props } from "herdr";
import { Listener } from "./listener.js";
import { FilesPanel } from "./files.js";

export default class FileLinks extends View {
  init(p, cx) {
    const cfg = props() ?? {};
    this.part = cfg.role === "files" ? new FilesPanel() : new Listener();
    this.part.init(p, cx);
  }

  render(cx) {
    return this.part.render(cx);
  }

  async close(cx) {
    await this.part.close?.(cx);
  }
}
