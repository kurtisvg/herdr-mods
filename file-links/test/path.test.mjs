// Run with: node --test file-links/test/path.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FRESH_MS,
  diskPath,
  displayPath,
  isAbsolutePath,
  isFreshRequest,
  lineToOffset,
  normalizePath,
  resolvePanelTarget,
  toPanelPath,
} from "../path.js";

const MOD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XDG_OPEN = path.join(MOD_DIR, "bin", "xdg-open");

test("normalizePath resolves dots, double slashes, and Windows separators", () => {
  assert.equal(normalizePath("/a/b/../c//d/."), "/a/c/d");
  assert.equal(normalizePath("a/b/../c"), "a/c");
  assert.equal(normalizePath("C:\\repo\\src\\index.js"), "C:/repo/src/index.js");
  assert.equal(isAbsolutePath("/tmp/a.txt"), true);
  assert.equal(isAbsolutePath("C:\\tmp\\a.txt"), true);
  assert.equal(isAbsolutePath("src/a.txt"), false);
});

test("toPanelPath maps in-root and symlinked files to relative paths without prefix collisions", () => {
  assert.equal(
    toPanelPath({ path: "/work/repo/src/main.js" }, "/work/repo"),
    "src/main.js",
  );
  assert.equal(
    toPanelPath(
      { path: "/link/file.md", realpath: "/work/repo/docs/file.md" },
      "/work/repo",
    ),
    "docs/file.md",
  );
  assert.equal(
    toPanelPath({ path: "/work/repo-other/src/main.js" }, "/work/repo"),
    "/work/repo-other/src/main.js",
  );
  assert.equal(toPanelPath({ path: "/etc/hosts" }, null), "/etc/hosts");
});

test("diskPath and displayPath handle relative, external, and home paths", () => {
  assert.equal(diskPath("/work/repo", "src/a.js"), "/work/repo/src/a.js");
  assert.equal(diskPath("/work/repo", "/tmp/a.js"), "/tmp/a.js");
  assert.equal(diskPath(null, "/tmp/a.js"), "/tmp/a.js");
  assert.equal(
    displayPath("/home/alice/.config/herdr-app/settings.json", "/home/alice"),
    "~/.config/herdr-app/settings.json",
  );
  assert.equal(displayPath("src/a.js", "/home/alice"), "src/a.js");
});

test("lineToOffset maps 1-based line and column to UTF-16 offsets including CRLF", () => {
  const lf = "first\nsecond\nthird";
  assert.equal(lineToOffset(lf, 1, 1), 0);
  assert.equal(lineToOffset(lf, 2, 1), 6);
  assert.equal(lineToOffset(lf, 2, 4), 9);
  assert.equal(lineToOffset(lf, 2, 99), 12);
  assert.equal(lineToOffset(lf, 99, 1), 13);

  const crlf = "ab\r\ncd\r\nef";
  assert.equal(lineToOffset(crlf, 2, 1), 4);
  assert.equal(lineToOffset(crlf, 2, 99), 6);
});

test("isFreshRequest accepts recent requests and rejects stale or malformed ones", () => {
  const now = 100000;
  assert.equal(
    isFreshRequest({ id: "1", path: "/tmp/a.txt", at: now - 500 }, now),
    true,
  );
  assert.equal(
    isFreshRequest({ id: "1", path: "/tmp/a.txt", at: now - FRESH_MS - 1 }, now),
    false,
  );
  assert.equal(isFreshRequest({ id: "", path: "/tmp/a.txt", at: now }, now), false);
  assert.equal(isFreshRequest(null, now), false);
});

test("resolvePanelTarget finds review-panel and ignores tabs/viewer roles", () => {
  const tree = {
    type: "column",
    children: [
      {
        id: "tabs",
        type: "block",
        content: { mod: "review-panel", props: { role: "tabs" } },
      },
      {
        id: "body",
        type: "row",
        children: [
          {
            id: "viewer",
            type: "block",
            content: { mod: "review-panel", props: { role: "viewer" } },
          },
          {
            id: "panel",
            type: "column",
            children: [
              {
                id: "panel-body",
                type: "stack",
                active: "review-panel",
                children: [
                  {
                    id: "review-panel",
                    type: "block",
                    content: { mod: "review-panel" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  assert.deepEqual(resolvePanelTarget(tree), {
    kind: "review-panel",
    panelId: "panel",
    stackId: "panel-body",
    childId: "review-panel",
  });
});

test("resolvePanelTarget selects drop-in file-links files role in a multi-child stack", () => {
  const tree = {
    type: "row",
    children: [
      {
        id: "panel",
        type: "column",
        children: [
          {
            id: "panel-body",
            type: "stack",
            active: "changes",
            children: [
              {
                id: "files",
                type: "block",
                content: { mod: "file-links", props: { role: "files" } },
              },
              {
                id: "changes",
                type: "block",
                content: { mod: "changes" },
              },
            ],
          },
        ],
      },
    ],
  };

  assert.deepEqual(resolvePanelTarget(tree), {
    kind: "files",
    panelId: "panel",
    stackId: "panel-body",
    childId: "files",
  });
});

async function withFakeEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "file-links-test-"));
  const appHome = path.join(tmp, "app-home");
  const fakeBin = path.join(tmp, "fake-bin");
  const logFile = path.join(tmp, "log.txt");
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const sockPath = path.join(appHome, "herdr-app.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(sockPath, resolve));

  const fakeXdg = path.join(fakeBin, "xdg-open");
  fs.writeFileSync(
    fakeXdg,
    `#!/bin/sh\nprintf 'xdg-open:%s\n' "$*" >> "${logFile}"\n`,
    { mode: 0o755 },
  );

  const fakeHerdr = path.join(fakeBin, "herdr-app");
  fs.writeFileSync(
    fakeHerdr,
    `#!/bin/sh\nprintf 'herdr-app:%s\n' "$*" >> "${logFile}"\nexit \${FAKE_HERDR_EXIT:-0}\n`,
    { mode: 0o755 },
  );

  try {
    await fn({ tmp, appHome, fakeBin, logFile });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("bin/xdg-open routes local files to Herdr and delegates URLs and non-files to real xdg-open", async () => {
  await withFakeEnv(({ tmp, appHome, fakeBin, logFile }) => {
    const sample = path.join(tmp, "hello world.md");
    fs.writeFileSync(sample, "line 1\nline 2\n");
    const colonFile = path.join(tmp, "note:12");
    fs.writeFileSync(colonFile, "literal colon\n");

    const baseEnv = {
      ...process.env,
      HERDR_APP_HOME: appHome,
      HERDR_FILE_LINKS_FORCE: "1",
      PATH: `${path.join(MOD_DIR, "bin")}:${fakeBin}:${process.env.PATH}`,
    };

    // 1. Web URL goes directly to real xdg-open.
    execFileSync(XDG_OPEN, ["https://example.com/docs"], { env: baseEnv });
    assert.equal(
      fs.readFileSync(logFile, "utf8").trim(),
      "xdg-open:https://example.com/docs",
    );
    fs.writeFileSync(logFile, "");

    // 2. Local path with :line:col writes request.json and runs `herdr-app do`.
    execFileSync(XDG_OPEN, [`${sample}:2:5`], { env: baseEnv });
    assert.equal(
      fs.readFileSync(logFile, "utf8").trim(),
      "herdr-app:do file-links.open",
    );
    const req1 = JSON.parse(
      fs.readFileSync(path.join(appHome, "data", "file-links", "request.json"), "utf8"),
    );
    assert.equal(req1.path, sample);
    assert.equal(req1.line, 2);
    assert.equal(req1.col, 5);
    fs.writeFileSync(logFile, "");

    // 3. file:// URI with %20 and #L2C3 decodes cleanly.
    const fileUrl = `file://${encodeURI(sample)}#L2C3`;
    execFileSync(XDG_OPEN, [fileUrl], { env: baseEnv });
    const req2 = JSON.parse(
      fs.readFileSync(path.join(appHome, "data", "file-links", "request.json"), "utf8"),
    );
    assert.equal(req2.path, sample);
    assert.equal(req2.line, 2);
    assert.equal(req2.col, 3);
    fs.writeFileSync(logFile, "");

    // 4. Existing file whose name literally ends in :12 is preserved intact.
    execFileSync(XDG_OPEN, [colonFile], { env: baseEnv });
    const req3 = JSON.parse(
      fs.readFileSync(path.join(appHome, "data", "file-links", "request.json"), "utf8"),
    );
    assert.equal(req3.path, colonFile);
    assert.equal(req3.line, null);
    fs.writeFileSync(logFile, "");

    // 5. Directory or missing file falls back to real xdg-open.
    execFileSync(XDG_OPEN, [tmp], { env: baseEnv });
    execFileSync(XDG_OPEN, [path.join(tmp, "missing.txt")], { env: baseEnv });
    assert.deepEqual(fs.readFileSync(logFile, "utf8").trim().split("\n"), [
      `xdg-open:${tmp}`,
      `xdg-open:${path.join(tmp, "missing.txt")}`,
    ]);
    fs.writeFileSync(logFile, "");

    // 6. Non-Herdr caller falls back to real xdg-open.
    const nonHerdrEnv = { ...baseEnv };
    delete nonHerdrEnv.HERDR_FILE_LINKS_FORCE;
    execFileSync(XDG_OPEN, [sample], { env: nonHerdrEnv });
    assert.equal(fs.readFileSync(logFile, "utf8").trim(), `xdg-open:${sample}`);
    fs.writeFileSync(logFile, "");

    // 7. Failed `herdr-app do` falls back to real xdg-open.
    execFileSync(XDG_OPEN, [sample], {
      env: { ...baseEnv, FAKE_HERDR_EXIT: "1" },
    });
    assert.deepEqual(fs.readFileSync(logFile, "utf8").trim().split("\n"), [
      "herdr-app:do file-links.open",
      `xdg-open:${sample}`,
    ]);
  });
});
