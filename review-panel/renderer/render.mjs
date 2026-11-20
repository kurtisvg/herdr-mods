#!/usr/bin/env node
// Renders Mermaid diagrams to PNG files using a local Chromium-based browser.
//
//   node render.mjs <job.json>
//
// job.json: { out: "<folder>", dark: boolean, scale?: number,
//             vars?: { ...mermaid themeVariables }, font?: string,
//             items: [{ id: "<name without ext>", code: "<mermaid source>" }] }
//
// Writes `<out>/<id>.png` for each diagram that renders and prints one JSON line:
//   { results: [{ id, ok: true, width, height } | { id, ok: false, error }] }
// `width` and `height` are in CSS pixels (the PNG has `scale` times as many).
// A fatal error (missing browser, missing packages, unreadable job) prints
//   { error: "..." } and exits 1.

import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const CHROMES = [
  process.env.REVIEW_CHROME,
  process.env.MARKDOWN_VIEWER_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

const jobPath = process.argv[2];
if (!jobPath) fail("usage: node render.mjs <job.json>");

let job;
try {
  job = JSON.parse(await readFile(jobPath, "utf8"));
} catch (e) {
  fail(`cannot read the job file: ${e.message}`);
}

const mermaidJs = join(HERE, "node_modules", "mermaid", "dist", "mermaid.min.js");
if (!existsSync(mermaidJs)) {
  fail("mermaid is not installed: run `npm install` in the renderer folder");
}

let puppeteer;
try {
  ({ default: puppeteer } = await import("puppeteer-core"));
} catch {
  fail("puppeteer-core is not installed: run `npm install` in the renderer folder");
}

const chrome = CHROMES.find((p) => existsSync(p));
if (!chrome) {
  fail(
    "no Chrome, Chromium, Edge or Brave found. Set REVIEW_CHROME to a browser executable.",
  );
}

await mkdir(job.out, { recursive: true });

let browser;
try {
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-first-run", "--disable-extensions"],
  });
} catch (e) {
  fail(`cannot start ${chrome}: ${e.message}`);
}

const results = [];
try {
  const page = await browser.newPage();
  const scale = job.scale ?? 2;
  await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: scale });
  await page.setContent(
    '<!doctype html><html><body style="margin:0;background:transparent">' +
      '<div id="stage" style="display:inline-block"></div></body></html>',
  );
  await page.addScriptTag({ path: mermaidJs });
  await page.evaluate(
    (dark, vars, font) => {
      const config = {
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
      };
      if (vars) {
        config.theme = "base";
        config.themeVariables = { darkMode: dark, ...vars };
      }
      if (font) config.fontFamily = font;
      window.mermaid.initialize(config);
    },
    Boolean(job.dark),
    job.vars ?? null,
    job.font ?? null,
  );

  let n = 0;
  for (const item of job.items ?? []) {
    n += 1;
    try {
      const size = await page.evaluate(
        async (code, key) => {
          const stage = document.getElementById("stage");
          stage.innerHTML = "";
          const { svg } = await window.mermaid.render(key, code);
          stage.innerHTML = svg;
          const el = stage.querySelector("svg");
          // Mermaid sizes diagrams as "100% up to max-width". Pin natural size.
          const box = el.viewBox?.baseVal;
          const natural =
            box && box.width
              ? { w: box.width, h: box.height }
              : el.getBoundingClientRect();
          el.style.maxWidth = "none";
          el.setAttribute("width", String(natural.w ?? natural.width));
          el.setAttribute("height", String(natural.h ?? natural.height));
          const r = el.getBoundingClientRect();
          return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
        },
        item.code,
        `mv-diagram-${n}`,
      );
      // Expand the viewport when a wide diagram would otherwise clip.
      await page.setViewport({
        width: Math.max(1600, size.width + 16),
        height: Math.max(1200, size.height + 16),
        deviceScaleFactor: scale,
      });
      const el = await page.$("#stage svg");
      await el.screenshot({
        path: join(job.out, `${item.id}.png`),
        omitBackground: true,
      });
      results.push({ id: item.id, ok: true, width: size.width, height: size.height });
    } catch (e) {
      // Clear any Mermaid error element left in `<body>` before the next diagram.
      await page
        .evaluate(() => {
          document.querySelectorAll("body > :not(#stage)").forEach((el) => {
            if (el.tagName !== "SCRIPT") el.remove();
          });
        })
        .catch(() => {});
      const error = String(e.message ?? e)
        .split("\n")
        .slice(0, 6)
        .join("\n");
      results.push({ id: item.id, ok: false, error });
    }
  }
} catch (e) {
  await browser.close().catch(() => {});
  fail(`rendering stopped: ${e.message}`);
}
await browser.close().catch(() => {});
console.log(JSON.stringify({ results }));
