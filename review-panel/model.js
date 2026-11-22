// review-panel: pure logic with no UI dependencies, tested in Node
// (review-panel/test/model.test.mjs).
//
// A row is one line on screen: { kind, n, text }.
//   kind " "  a line of the file as it is now       n = its line number
//   kind "+"  a line added since the last commit    n = its line number now
//   kind "-"  a line removed since the last commit  n = its old line number
//   kind "@"  a hunk header, kind "" any other diff text; neither can be selected
//
// A comment is { id, path, from, to, removed, mixed, gap, quote, text, view }
// plus, once it has been worked with:
//   state       "draft" (not sent; also when absent), "open" (sent), or "resolved"
//   thread      what was said after the comment: [{ by: "agent" | "me", text, at }]
//   reply       a follow-up written locally and not sent yet
//   resend      reopened since it was last sent, so the next review names it again
//   seen        the agent's reply file as last read, so it is not applied twice
//   resolvedAt  when it was resolved, for expiring old resolved comments
//
// Comments are kept in sets. A set is one tab's comments on one folder:
//   { key, tab, name, named, on, root, seq, note, comments, closedAt }
//   key          8 hex digits: the name of the set's reply folder
//   tab          the Herdr tab id; "" when no tab was known; null for legacy sets
//   name, named  the tab's name when last seen, and whether the user named it
//   on, root     the machine (null: local) and folder the comments inspect
//   seq          the last comment number used, so ids are never reused
//   closedAt     when the tab was first seen closed; absent while open

// Text draws a tab as zero width: pad each tab to the next 4-column stop.
// Return lines without tabs immediately so long lines avoid the regex scan.
export const untab = (text) =>
  text.includes("\t")
    ? text.replace(/[^\t]*\t/g, (s) => {
        const len = s.length - 1;
        return s.slice(0, -1).padEnd(len - (len % 4) + 4);
      })
    : text;

export const isLine = (row) =>
  row.kind === " " || row.kind === "+" || row.kind === "-";

// The rows of a whole file.
export function fileRows(text) {
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line, i) => ({
      kind: " ",
      n: i + 1,
      text: line.replace(/\r$/, ""),
    }));
}

// The rows of `git diff` output, from its first "@@" line on.
export function diffRows(lines) {
  let old = 0;
  let next = 0;
  return lines.map((raw) => {
    const line = raw.replace(/\r$/, "");
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line };
    }
    const kind = line[0];
    const text = line.slice(1);
    if (kind === "-") return { kind, n: old++, text };
    if (kind === "+") return { kind, n: next++, text };
    if (kind === " ") {
      old++;
      return { kind, n: next++, text };
    }
    return { kind: "", text: line };
  });
}

export const GAP = "…";

// What rows a..b (either order) say about a comment made on them: where it
// points and the text to quote. Null when the range holds no selectable line.
//   - Current lines give the range. Removed lines among them are quoted too,
//     and every quoted line then starts with its diff mark (`mixed`).
//   - Only removed lines: the range uses their old line numbers (`removed`).
//   - Crossing a hunk header inserts a gap marker (`gap`).
export function selection(rows, a, b, path) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const picked = [];
  const quoted = [];
  let crossed = false;
  let gap = false;
  for (let i = lo; i <= hi; i++) {
    const row = rows[i];
    if (!row) continue;
    if (!isLine(row)) {
      if (row.kind === "@" && picked.length) crossed = true;
      continue;
    }
    if (crossed) {
      quoted.push(null);
      gap = true;
      crossed = false;
    }
    picked.push(row);
    quoted.push(row);
  }
  if (!picked.length) return null;

  const kept = picked.filter((row) => row.kind !== "-");
  const removed = kept.length === 0;
  const mixed = !removed && kept.length !== picked.length;
  const range = removed ? picked : kept;
  return {
    path,
    from: range[0].n,
    to: range[range.length - 1].n,
    removed,
    mixed,
    gap,
    quote: quoted.map((row) =>
      row === null ? GAP : mixed ? row.kind + row.text : row.text,
    ),
  };
}

// "12", "12-14", "12 (removed)".
export const lines = (c) =>
  `${c.from}${c.to !== c.from ? `-${c.to}` : ""}${c.removed ? " (removed)" : ""}`;

// "src/app.py:12-14".
export const where = (c) => `${c.path}:${lines(c)}`;

// Maps a UTF-16 selection [start, end) in EditorState to 0-based rows of `text`.
// When a selection ends right after a newline (such as a triple-clicked line),
// keep that trailing newline on the preceding line rather than pulling in the next.
export function editorLines(text, start, end, rowCount) {
  if (!rowCount || rowCount <= 0) return { anchor: 0, head: 0 };
  const lo = Math.max(0, Math.min(start, end, text.length));
  let hi = Math.max(lo, Math.min(Math.max(start, end), text.length));
  if (hi > lo && text[hi - 1] === "\n") hi -= 1;

  let anchor = 0;
  for (let i = 0; i < lo; i++) {
    if (text[i] === "\n") anchor += 1;
  }
  let head = anchor;
  for (let i = lo; i < hi; i++) {
    if (text[i] === "\n") head += 1;
  }
  const last = rowCount - 1;
  return { anchor: Math.min(anchor, last), head: Math.min(head, last) };
}

// Index of the row a comment hangs under (its last line), or -1 when absent.
export function locate(c, rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (isLine(row) && (row.kind === "-") === Boolean(c.removed) && row.n === c.to) {
      return i;
    }
  }
  return -1;
}

// True when every line of the comment is shown and its text differs from the quote.
export function outdated(c, rows) {
  if (c.removed || c.mixed || c.gap) return false;
  const now = rows.filter(
    (row) => isLine(row) && row.kind !== "-" && row.n >= c.from && row.n <= c.to,
  );
  if (now.length !== c.to - c.from + 1) return false;
  return now.some((row, i) => row.text !== c.quote[i]);
}

export function sortComments(comments) {
  const number = (c) => Number(String(c.id).slice(1)) || 0;
  return [...comments].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.from - b.from ||
      number(a) - number(b),
  );
}

// A long quote keeps its first and last four lines.
const KEEP = 4;
export function shortQuote(quote) {
  if (quote.length <= KEEP * 2 + 2) return quote;
  return [
    ...quote.slice(0, KEEP),
    `${GAP} (${quote.length - KEEP * 2} more lines)`,
    ...quote.slice(-KEEP),
  ];
}

export const stateOf = (c) => c.state ?? "draft";

// Comments sent on the next Submit: drafts, follow-ups, and reopened comments.
export const unsent = (comments) =>
  comments.filter(
    (c) => stateOf(c) === "draft" || Boolean(c.reply) || Boolean(c.resend),
  );

// Folder where the agent writes one `<id>.md` reply per comment inside the
// reviewed checkout. `.herdr/.gitignore` keeps it untracked in git repos.
export const replyFolder = (root, key) =>
  `${root.replace(/[\\/]+$/, "")}/.herdr/review/${key}`;

// Parses an optional leading `Status: resolved | open` line and reply body.
export function parseReply(content) {
  const text = content.replace(/\r/g, "").trim();
  const match =
    /^[*_`]*status[*_`\s]*:[*_`\s]*(resolved|closed|done|open)\b[^\n]*(\n|$)/i.exec(
      text,
    );
  if (!match) return { status: null, text };
  return {
    status: match[1].toLowerCase() === "open" ? "open" : "resolved",
    text: text.slice(match[0].length).trim(),
  };
}

// Applies the agent's reply file for a comment. Returns true when it changed.
// Re-reading identical `seen` content is a no-op so local reopening sticks.
export function applyReply(c, content, at) {
  if (stateOf(c) === "draft" || !content.trim() || content === c.seen) {
    return false;
  }
  c.seen = content;
  const reply = parseReply(content);
  const thread = (c.thread ??= []);
  if (reply.text) {
    // A reply rewritten before any new user turn replaces the earlier wording.
    if (thread.length && thread[thread.length - 1].by === "agent") {
      thread[thread.length - 1] = { by: "agent", text: reply.text, at };
    } else {
      thread.push({ by: "agent", text: reply.text, at });
    }
  }
  if (reply.status) {
    if (c.reply) {
      c.state = "open";
      delete c.resolvedAt;
    } else {
      c.state = reply.status;
      if (reply.status === "resolved") {
        c.resolvedAt = at;
        delete c.resend;
      } else {
        delete c.resolvedAt;
      }
    }
  }
  return true;
}

// Marks sent comments open and moves queued follow-ups or reopen markers into
// their threads so the agent's next reply appends instead of overwriting.
export function markSent(comments, at) {
  for (const c of comments) {
    if (c.reply) (c.thread ??= []).push({ by: "me", text: c.reply, at });
    else if (c.resend) (c.thread ??= []).push({ by: "me", text: "Reopened.", at });
    delete c.reply;
    delete c.resend;
    c.state = "open";
  }
}

// Formats the review prompt sent to the agent via `hc send`.
export function formatReview({ root, note, comments, replies }) {
  const sorted = sortComments(comments);
  const files = new Set(sorted.map((c) => c.path)).size;
  const out = [
    `Review comments (${files} ${files === 1 ? "file" : "files"}) in ${root}`,
  ];
  if (replies) {
    out.push(
      `Reply to each comment by writing a file named after its id, ` +
        `such as ${sorted[0].id}.md, in ${replies}/`,
      'Start the file with the line "Status: resolved" if the comment is ' +
        'dealt with, or "Status: open" if you need my answer. Then your reply.',
    );
  }
  if (note?.trim()) out.push("", note.trim());
  for (const c of sorted) {
    const sent = stateOf(c) !== "draft";
    const tag = !sent ? "" : c.reply ? " (follow-up)" : " (reopened)";
    out.push(
      "",
      `[${c.id}] ${where(c)}${tag}`,
      ...shortQuote(c.quote).map((line) => (line ? `> ${line}` : ">")),
      (sent && c.reply ? c.reply : c.text).trim(),
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- sets

export const DAY = 86400000;
export const KEEP_DAYS = 30;

const same = (s, on, root) => (s.on ?? null) === (on ?? null) && s.root === root;

export const newSet = (tab, on, root, key) => ({
  key,
  tab,
  name: "",
  named: false,
  on: on ?? null,
  root,
  seq: 0,
  note: "",
  comments: [],
});

// Finds a tab's set on a folder, open or closed (a remote machine may reconnect).
export const findSet = (sets, tab, on, root) =>
  sets.find((s) => s.tab === tab && same(s, on, root));

// Migrates legacy per-folder `{ "<machine>|<folder>": { seq, note, comments } }`
// storage into closed sets that a tab can adopt.
export function migrate(old, now, key) {
  return Object.entries(old ?? {})
    .filter(([, e]) => e && (e.comments?.length || e.note))
    .map(([ctx, e]) => {
      const bar = ctx.indexOf("|");
      return {
        key: key(),
        tab: null,
        name: "",
        named: false,
        on: ctx.slice(0, bar) || null,
        root: ctx.slice(bar + 1),
        seq: e.seq ?? 0,
        note: e.note ?? "",
        comments: e.comments ?? [],
        closedAt: now,
      };
    });
}

// Reconciles stored sets with open tabs. Returns true when any set changed.
//   live(tab)  { name, named } for an open tab, else undefined
//   ready(on)  whether that machine's tabs are loaded (connecting machines wait)
// Expires closed sets and resolved comments after KEEP_DAYS, and drops empty
// closed sets immediately.
export function sweep(sets, live, ready, now) {
  let changed = false;
  for (const s of sets) {
    const tab =
      s.tab === "" ? { name: "", named: false } : s.tab ? live(s.tab) : undefined;
    if (tab) {
      if (s.closedAt) {
        delete s.closedAt;
        changed = true;
      }
      if (s.name !== tab.name || s.named !== tab.named) {
        s.name = tab.name;
        s.named = tab.named;
        changed = true;
      }
    } else if (!s.closedAt && ready(s.on ?? null)) {
      s.closedAt = now;
      changed = true;
    }
    for (const c of s.comments) {
      if (stateOf(c) === "resolved" && !c.resolvedAt) {
        c.resolvedAt = now;
        changed = true;
      }
    }
    const kept = s.comments.filter(
      (c) => stateOf(c) !== "resolved" || now - c.resolvedAt <= KEEP_DAYS * DAY,
    );
    if (kept.length !== s.comments.length) {
      s.comments = kept;
      changed = true;
    }
  }
  const keep = sets.filter(
    (s) =>
      !s.closedAt ||
      (now - s.closedAt <= KEEP_DAYS * DAY &&
        (s.comments.length > 0 || Boolean(s.note))),
  );
  if (keep.length !== sets.length) {
    sets.splice(0, sets.length, ...keep);
    changed = true;
  }
  return changed;
}

// Picks a unique closed set on the same folder whose tab had the same custom
// name, provided this tab has no comments or note of its own yet.
export function adoptable(sets, tab, name, named, on, root) {
  if (!tab || !named) return null;
  const own = findSet(sets, tab, on, root);
  if (own && (own.comments.length || own.note)) return null;
  const found = sets.filter(
    (s) => s.closedAt && s.named && s.name === name && same(s, on, root),
  );
  return found.length === 1 ? found[0] : null;
}

// Hands a closed set to `tab`, renumbering incoming comments if `tab` already
// has comments or a note on that folder. Returns `tab`'s active set.
export function attach(sets, from, tab, on, root) {
  const own = findSet(sets, tab, on, root);
  if (!sets.includes(from)) return own ?? from;
  if (own && own !== from && (own.comments.length || own.note)) {
    for (const c of from.comments) {
      own.seq += 1;
      c.id = `c${own.seq}`;
      delete c.seen;
      own.comments.push(c);
    }
    sets.splice(sets.indexOf(from), 1);
    return own;
  }
  if (own && own !== from) sets.splice(sets.indexOf(own), 1);
  from.tab = tab;
  delete from.closedAt;
  return from;
}

// ---------------------------------------------------------------- per-tab state

// The machine of a tab id, or null for this computer. Ids on another machine
// start with its name and a slash.
export const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : null);

// Whether two layout sizes, `{ px }` or `{ weight }`, are the same size.
// Herdr stores sizes with less precision than JSON numbers have.
export const sameSize = (a, b) =>
  Math.abs((a?.px ?? 0) - (b?.px ?? 0)) < 0.5 &&
  Math.abs((a?.weight ?? 0) - (b?.weight ?? 0)) < 0.001;

// Whether the side panel already shows what a tab saved. `saved` and `now`
// are `{ mode, sizes }`: a null `mode` is a closed panel, and `sizes` maps
// layout node ids to sizes. A closed panel has no size to compare.
export function samePanel(saved, now) {
  if ((saved.mode ?? null) !== now.mode) return false;
  if (!saved.mode || !saved.sizes) return true;
  return Object.keys(saved.sizes).every((id) =>
    sameSize(saved.sizes[id], now.sizes[id]),
  );
}

// ---------------------------------------------------------------- markdown

export const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path ?? "");

// FNV-1a hash used to key rendered markdown blocks by text.
export function textKey(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Splits a markdown file into clickable visual blocks: [{ kind, from, to, text }]
// with 1-based inclusive line numbers. Mermaid blocks (`kind: "mermaid"`) carry
// `code` without fences. When `where` is given (see liftPictures), blocks that
// reference local pictures also carry `pictures` and `shown`.
export function markdownBlocks(text, where) {
  const src = text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  const out = [];
  let cur = null;

  const close = () => {
    if (!cur) return;
    while (cur.lines.length && !cur.lines[cur.lines.length - 1].trim()) {
      cur.lines.pop();
    }
    const block = {
      kind: cur.mermaid ? "mermaid" : "md",
      from: cur.from,
      to: cur.from + cur.lines.length - 1,
      text: cur.lines.join("\n"),
    };
    if (cur.mermaid) {
      block.code = cur.lines.slice(1, cur.closed ? -1 : undefined).join("\n");
    }
    out.push(block);
    cur = null;
  };
  const start = (type, i, extra) => {
    close();
    cur = { type, from: i + 1, lines: [src[i]], ...extra };
  };
  const indented = (line) => /^(\t| {2,})\S/.test(line);

  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    if (cur?.type === "fence") {
      cur.lines.push(line);
      const end = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (end && end[1][0] === cur.char && end[1].length >= cur.length) {
        cur.closed = true;
        close();
      }
      continue;
    }
    const fence = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(line);
    if (fence) {
      const mark = fence[1] ?? fence[3];
      const lang = /^\s*\{?\.?([^\s`}]*)/.exec(fence[2] ?? fence[4])[1];
      start("fence", i, {
        char: mark[0],
        length: mark.length,
        mermaid: lang.toLowerCase() === "mermaid",
      });
      continue;
    }
    if (!line.trim()) {
      // Blank lines end a block unless a list item continues indented below.
      let next = i + 1;
      while (next < src.length && !src[next].trim()) next++;
      if (cur?.type === "item" && next < src.length && indented(src[next])) {
        cur.lines.push(line);
      } else {
        close();
      }
      continue;
    }
    if (/^ {0,3}#{1,6}(\s|$)/.test(line)) {
      start("heading", i);
      close();
      continue;
    }
    if (cur?.type === "para" && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      cur.lines.push(line);
      close();
      continue;
    }
    if (/^ {0,3}([-*_])( *\1){2,}\s*$/.test(line)) {
      start("rule", i);
      close();
      continue;
    }
    if (cur?.type === "item" && indented(line)) {
      cur.lines.push(line);
      continue;
    }
    if (/^ {0,3}([-*+]|\d{1,9}[.)])\s/.test(line)) {
      start("item", i);
      continue;
    }
    const type = /^ {0,3}\|/.test(line)
      ? "table"
      : /^ {0,3}>/.test(line)
        ? "quote"
        : "para";
    if (
      cur &&
      (cur.type === type ||
        (type === "para" && (cur.type === "item" || cur.type === "quote")))
    ) {
      cur.lines.push(line);
    } else {
      start(type, i);
    }
  }
  close();

  if (where) {
    for (const block of out) {
      if (block.kind !== "md") continue;
      const lifted = liftPictures(block.text, where);
      if (lifted.pictures.length) {
        block.shown = lifted.text;
        block.pictures = lifted.pictures;
      }
    }
  }
  return out;
}

// Tracks CommonMark blockquote/list/fence context line by line so callers can
// distinguish real opening/closing fences and 4-space indented code blocks from
// prose, nested inner fences, and inline backtick code spans.
function createFenceScanner() {
  const lists = [];
  let fence = null;
  let blank = true;
  let para = false;

  return function step(line) {
    let i = 0;
    let col = 0;
    let baseCol = 0;
    let quote = 0;
    const maxQuote = fence ? fence.quote : Infinity;
    while (quote < maxQuote && i < line.length) {
      let j = i;
      let c = col;
      while (j < line.length && line[j] === " " && c - col < 3) {
        j++;
        c++;
      }
      if (line[j] !== ">") break;
      quote++;
      j++;
      c++;
      if (line[j] === " ") {
        j++;
        c++;
        baseCol = c;
      } else if (line[j] === "\t") {
        baseCol = c + 1;
      } else {
        baseCol = c;
      }
      i = j;
      col = c;
    }
    if (lists.some((it) => it.quote > quote)) {
      while (lists.length && lists[lists.length - 1].quote > quote) lists.pop();
      blank = false;
      para = false;
    }
    if (fence && quote < fence.quote) fence = null;

    let j = i;
    let curCol = col;
    while (j < line.length && (line[j] === " " || line[j] === "\t")) {
      curCol = line[j] === "\t" ? curCol + 4 - (curCol % 4) : curCol + 1;
      j++;
    }
    const indent = curCol - baseCol;
    const rest = line.slice(j).replace(/\r$/, "");

    if (fence) {
      if (rest && indent < fence.base) {
        fence = null;
      } else {
        const close = indent <= fence.base + 3 && /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
          const closed = fence;
          fence = null;
          blank = false;
          para = false;
          return { kind: "close", fence: closed };
        }
        return { kind: "inside", fence };
      }
    }

    if (!rest) {
      blank = true;
      para = false;
      return { kind: "blank" };
    }

    const interrupts =
      /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest) ||
      /^#{1,6}(?:[ \t]|$)/.test(rest) ||
      /^(?:`{3,}[^`]*|~{3,}.*)$/.test(rest) ||
      /^([-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest);
    if (blank || interrupts) {
      while (
        lists.length &&
        lists[lists.length - 1].quote === quote &&
        indent < lists[lists.length - 1].indent
      ) {
        lists.pop();
      }
    }

    let base =
      lists.length && lists[lists.length - 1].quote === quote
        ? lists[lists.length - 1].indent
        : 0;
    if (!para && indent >= base + 4) {
      blank = false;
      return { kind: "text", code: true };
    }

    let pos = j;
    let cur = indent;
    while (cur <= base + 3) {
      const tail = line.slice(pos).replace(/\r$/, "");
      if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(tail)) {
        blank = false;
        para = false;
        return { kind: "text", code: false };
      }
      const m = /^([-*+]|\d{1,9}[.)])([ \t]+|$)/.exec(tail);
      if (!m) break;
      let k = pos + m[1].length;
      let nextCol = curCol + m[1].length;
      while (k < line.length && (line[k] === " " || line[k] === "\t")) {
        nextCol = line[k] === "\t" ? nextCol + 4 - (nextCol % 4) : nextCol + 1;
        k++;
      }
      const next = nextCol - baseCol;
      const empty = k >= line.length || line[k] === "\r";
      const content =
        empty || next - (cur + m[1].length) >= 5 ? cur + m[1].length + 1 : next;
      lists.push({ quote, indent: content });
      base = content;
      if (empty) {
        blank = false;
        para = false;
        return { kind: "text", code: false };
      }
      pos = k;
      cur = next;
      curCol = nextCol;
      if (cur > base + 3) {
        blank = false;
        para = false;
        return { kind: "text", code: true };
      }
    }

    blank = false;
    const tail = line.slice(pos).replace(/\r$/, "");
    const open =
      cur <= base + 3 &&
      (/^(`{3,})([^`]*)$/.exec(tail) || /^(~{3,})(.*)$/.exec(tail));
    if (!open) {
      const heading = cur <= base + 3 && /^#{1,6}(?:[ \t]|$)/.test(tail);
      const setext = para && cur <= base + 3 && /^(=+|-+)[ \t]*$/.test(tail);
      para = !heading && !setext;
      return { kind: "text", code: false };
    }
    const lang = /^\s*\{?\.?([^\s`}]*)/.exec(open[2])[1];
    fence = {
      quote,
      base,
      char: open[1][0],
      length: open[1].length,
      lang,
      info: open[2],
      pos,
      mark: open[1],
    };
    para = false;
    return { kind: "open", fence };
  };
}

// TextView.markdown draws no syntax colors, and a fence with a language label
// gets extra top padding. Stripping opening fence languages keeps padding even
// while leaving inner example fences and 4-space indented code blocks intact.
export function bareFences(text) {
  const step = createFenceScanner();
  return text
    .split("\n")
    .map((line) => {
      const r = step(line);
      if (r.kind !== "open" || !r.fence.info.trim()) return line;
      return (
        line.slice(0, r.fence.pos) +
        r.fence.mark +
        (line.endsWith("\r") ? "\r" : "")
      );
    })
    .join("\n");
}

// Block index a comment hangs under: the block containing `line`, else the
// nearest block before a blank line, else -1.
export function blockFor(blocks, line) {
  let before = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].from <= line && line <= blocks[i].to) return i;
    if (blocks[i].to < line) before = i;
  }
  return before;
}

// ---------------------------------------------------------------- pictures and viewer segments

// Resolves a local path or `file://` URL `src` against folder `dir`, returning
// a normalized `/...` path or null for web URLs, custom schemes, empty anchors,
// or relative paths without `dir`.
export function pictureFile(src, dir) {
  let s = src.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
  if (/^file:\/\//i.test(s)) {
    if (!/^file:\/\/(?:localhost)?\//i.test(s)) return null;
    s = s.replace(/^file:\/\/(?:localhost)?/i, "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) {
    return null;
  }
  s = s.replace(/[?#].*$/, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // Keep literal `%` sequences when not valid percent-encoding.
  }
  if (!s) return null;
  if (!s.startsWith("/")) {
    if (!dir) return null;
    s = `${dir}/${s}`;
  }
  const parts = [];
  for (const part of s.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}

const DEST = String.raw`<[^>]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+`;
const TITLE = String.raw`(?:\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?`;
const PICTURE = String.raw`!\[((?:\\.|[^\]\\])*)\]\(\s*(${DEST})${TITLE}\s*\)`;
const TOKEN = new RegExp(
  String.raw`\[\s*${PICTURE}\s*\]\(\s*(${DEST})${TITLE}\s*\)|${PICTURE}|<img\b[^>]*>`,
  "iy",
);
const plain = (s) => s.replace(/\\([!-\/:-@\[-`{-~])/g, "$1");

function attr(tag, name) {
  const m = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// Extracts local pictures from one markdown line into `held`, returning the
// remaining line text (with inline pictures replaced by alt text) or null when
// the line held only standalone pictures/HTML wrappers. Skips inline code spans.
function liftLine(line, where, held) {
  let out = "";
  let rest = "";
  let found = false;
  let i = 0;
  const keep = (s) => {
    out += s;
    rest += s;
    i += s.length;
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      keep(line.slice(i, i + 2));
      continue;
    }
    if (c === "`") {
      let j = i;
      while (line[j] === "`") j += 1;
      const run = j - i;
      let k = j;
      let end = -1;
      while (k < line.length) {
        if (line[k] !== "`") {
          k += 1;
          continue;
        }
        let m = k;
        while (line[m] === "`") m += 1;
        if (m - k === run) {
          end = m;
          break;
        }
        k = m;
      }
      keep(line.slice(i, end < 0 ? j : end));
      continue;
    }
    if (c === "!" || c === "[" || c === "<") {
      TOKEN.lastIndex = i;
      const m = TOKEN.exec(line);
      if (m) {
        const tag = m[0][0] === "<";
        const src = tag ? attr(m[0], "src") : plain(m[2] ?? m[5]);
        const path = src ? where(src) : null;
        if (path) {
          const alt = tag ? (attr(m[0], "alt") ?? "") : (m[1] ?? m[4]);
          const rawWidth = tag ? Number(attr(m[0], "width")) : 0;
          const width =
            rawWidth > 0 && Number.isFinite(rawWidth) ? rawWidth : null;
          const href = !tag && m[3] ? plain(m[3]).replace(/^<|>$/g, "") : null;
          held.push(
            href ? { path, src, alt, width, href } : { path, src, alt, width },
          );
          out += alt;
          found = true;
          i += m[0].length;
          continue;
        }
      }
    }
    keep(c);
  }
  if (!found) return line;
  return /^(\s|<\/?[a-z][^>]*>)*$/i.test(rest) ? null : out;
}

// Takes the local pictures out of a block of markdown. `where(src)` gives the
// path of a picture on this computer, or null for a picture to leave in the
// text (a web address). Returns `{ text, pictures }`: the text without the
// pictures, and `[{ path, src, alt, width, href? }]` in the order of the text.
// `width` is what an `<img>` tag asks for in pixels, else null.
//   - A picture alone on its line is taken out with its line.
//   - A picture inside a sentence, a table cell or a list item leaves its alt
//     text in its place.
//   - Code spans and fenced or indented code blocks stay untouched.
export function liftPictures(text, where) {
  const held = [];
  const out = [];
  const step = createFenceScanner();
  for (const line of text.split("\n")) {
    const r = step(line);
    if (r.kind !== "text" || r.code) {
      out.push(line);
      continue;
    }
    const kept = liftLine(line, where, held);
    if (kept !== null) out.push(kept);
  }
  return { text: out.join("\n"), pictures: held };
}

// Splits a markdown document into ordered `"md"`, `"pictures"`, and `"mermaid"`
// segments for `doc.js`, stripping opening fence languages on markdown fences
// while preserving inner example fences and 4-space indented code blocks.
// `where(src)`: see `liftPictures`.
export function splitMarkdown(text, where) {
  const out = [];
  const step = createFenceScanner();
  let md = [];
  let mermaidBody = null;
  let held = [];
  let gap = false;

  const flush = () => {
    const chunk = bareFences(md.join("\n"));
    if (chunk.trim()) out.push({ kind: "md", text: chunk, id: textKey(chunk) });
    md = [];
  };
  const settle = () => {
    if (!held.length) return;
    flush();
    out.push({
      kind: "pictures",
      items: held,
      id: textKey(held.map((p) => `${p.path}\n${p.alt}`).join("\n")),
    });
    held = [];
  };
  const diagram = (code, open) => out.push({ kind: "mermaid", code, open });

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const r = step(line);
    if (mermaidBody !== null) {
      if (r.kind === "inside") {
        mermaidBody.push(line);
        continue;
      }
      // The diagram ends at its closing fence. It also ends when the scanner
      // leaves the fence without one, because the list item or the blockquote
      // that holds the fence ended. That line is ordinary markdown again.
      diagram(mermaidBody.join("\n"), r.kind !== "close");
      mermaidBody = null;
      if (r.kind === "close") continue;
    }
    if (r.kind === "inside" || r.kind === "close") {
      md.push(line);
      continue;
    }
    if (!line.trim()) {
      gap = true;
      md.push(line);
      continue;
    }

    if (gap && !/^[ \t]/.test(line)) settle();
    gap = false;

    // A line that holds only blockquote marks is blank to the scanner.
    if (r.kind === "blank") {
      md.push(line);
      continue;
    }
    if (r.kind === "open") {
      // A Mermaid fence is drawn when it is outside every blockquote and
      // starts within three spaces of the margin. This includes a fence under
      // a list item, as in `markdownBlocks`.
      const drawable = r.fence.quote === 0 && /^ {0,3}[`~]/.test(line);
      if (drawable && r.fence.lang.toLowerCase() === "mermaid") {
        settle();
        flush();
        mermaidBody = [];
      } else {
        md.push(line);
      }
      continue;
    }
    if (r.code || !where) {
      md.push(line);
      continue;
    }
    const kept = liftLine(line, where, held);
    if (kept !== null) md.push(kept);
  }
  if (mermaidBody !== null) diagram(mermaidBody.join("\n"), true);
  settle();
  flush();
  return out;
}

// ---------------------------------------------------------------- markdown wrapping

function scanCodeSpan(text, start) {
  let j = start;
  while (text[j] === "`") j += 1;
  const run = j - start;
  let k = j;
  while (k < text.length) {
    if (text[k] !== "`") {
      k += 1;
      continue;
    }
    let m = k;
    while (text[m] === "`") m += 1;
    if (m - k === run) return m;
    k = m;
  }
  return -1;
}

function scanInlineLink(text, start) {
  let i = text[start] === "!" ? start + 1 : start;
  if (text[i] !== "[") return -1;
  i += 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === "`") {
      const end = scanCodeSpan(text, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") depth -= 1;
    i += 1;
  }
  if (depth !== 0 || text[i] !== "(") return -1;
  i += 1;
  depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    i += 1;
  }
  return depth === 0 ? i : -1;
}

function tokenizeProse(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
    if (i >= text.length) break;
    const start = i;
    while (i < text.length && text[i] !== " " && text[i] !== "\t") {
      if (text[i] === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (text[i] === "`") {
        const end = scanCodeSpan(text, i);
        if (end > 0) {
          i = end;
          continue;
        }
      }
      if (text[i] === "[" || (text[i] === "!" && text[i + 1] === "[")) {
        const end = scanInlineLink(text, i);
        if (end > 0) {
          i = end;
          continue;
        }
      }
      i += 1;
    }
    tokens.push(text.slice(start, i));
  }
  return tokens;
}

function wrapTokens(tokens, firstPrefix, contPrefix, width) {
  if (!tokens.length) return [firstPrefix.trimEnd()];
  const out = [];
  let prefix = firstPrefix;
  let line = "";
  for (const token of tokens) {
    if (!line) {
      line = prefix + token;
    } else if (line.length + 1 + token.length <= width) {
      line += " " + token;
    } else {
      out.push(line);
      prefix = contPrefix;
      line = prefix + token;
    }
  }
  if (line) out.push(line);
  return out;
}

function hasUnescapedPipe(line) {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\" && i + 1 < line.length) {
      i += 2;
      continue;
    }
    if (line[i] === "`") {
      const end = scanCodeSpan(line, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (line[i] === "|") return true;
    i += 1;
  }
  return false;
}

function hardBreakSuffix(line) {
  const spaces = / {2,}$/.exec(line);
  if (spaces) return spaces[0];
  let slashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1 ? "\\" : "";
}

const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const REF_LINK_DEF = /^ {0,3}\[[^\]]+\]:[ \t]*\S/;
const HTML_LINE =
  /^[ \t]*(?:<!--|<!\[CDATA\[|<![A-Za-z]|<\?|<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;
const TABLE_SEP =
  /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*\|[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const SINGLE_COL_TABLE_SEP = /^[ \t]*\|[ \t]*:?-{1,}:?[ \t]*\|[ \t]*$/;

function splitTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const pipes = [];
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
      i += 2;
      continue;
    }
    if (trimmed[i] === "`") {
      const end = scanCodeSpan(trimmed, i);
      if (end > 0) {
        i = end;
        continue;
      }
    }
    if (trimmed[i] === "|") pipes.push(i);
    i += 1;
  }
  if (!pipes.length) return null;
  const start = pipes[0] === 0 ? 1 : 0;
  const end =
    pipes[pipes.length - 1] === trimmed.length - 1
      ? trimmed.length - 1
      : trimmed.length;
  const cells = [];
  let from = start;
  for (const pos of pipes) {
    if (pos < start || pos >= end) continue;
    cells.push(trimmed.slice(from, pos).trim());
    from = pos + 1;
  }
  cells.push(trimmed.slice(from, end).trim());
  return cells;
}

function parseTableDelimiter(cells) {
  if (!cells || !cells.length) return null;
  const alignments = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    alignments.push(
      left && right
        ? "center"
        : right
          ? "right"
          : left
            ? "left-explicit"
            : "left",
    );
  }
  return alignments;
}

function formatTable(prefix, rows, alignments) {
  const cols = Math.max(alignments.length, ...rows.map((r) => r.length));
  const align = Array.from({ length: cols }, (_, c) => alignments[c] ?? "left");
  const minWidth = (a) =>
    a === "center" ? 5 : a === "right" || a === "left-explicit" ? 4 : 3;
  const widths = Array.from({ length: cols }, (_, c) => {
    let w = minWidth(align[c]);
    for (const row of rows) {
      const len = (row[c] ?? "").length;
      if (len > w) w = len;
    }
    return w;
  });

  const padCell = (text, w, a) => {
    const pad = w - text.length;
    if (a === "right") return " ".repeat(pad) + text;
    if (a === "center") {
      const leftPad = Math.floor(pad / 2);
      return " ".repeat(leftPad) + text + " ".repeat(pad - leftPad);
    }
    return text + " ".repeat(pad);
  };

  const delimCell = (w, a) => {
    if (a === "center") return ":" + "-".repeat(w - 2) + ":";
    if (a === "right") return "-".repeat(w - 1) + ":";
    if (a === "left-explicit") return ":" + "-".repeat(w - 1);
    return "-".repeat(w);
  };

  const renderRow = (cells) =>
    `${prefix}| ${cells.join(" | ")} |`;

  const out = [
    renderRow(
      Array.from({ length: cols }, (_, c) =>
        padCell(rows[0][c] ?? "", widths[c], align[c]),
      ),
    ),
    renderRow(
      Array.from({ length: cols }, (_, c) => delimCell(widths[c], align[c])),
    ),
  ];
  for (let r = 1; r < rows.length; r += 1) {
    out.push(
      renderRow(
        Array.from({ length: cols }, (_, c) =>
          padCell(rows[r][c] ?? "", widths[c], align[c]),
        ),
      ),
    );
  }
  return out;
}

function reflowMarkdown(text, width, formatTables) {
  if (!text) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const step = createFenceScanner();
  const allLines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = null;
  let inTable = false;

  const flush = () => {
    if (!para) return;
    for (let i = 0; i < para.segments.length; i += 1) {
      const seg = para.segments[i];
      const firstPrefix = i === 0 ? para.firstPrefix : para.contPrefix;
      const wrapped = wrapTokens(
        tokenizeProse(seg.text),
        firstPrefix,
        para.contPrefix,
        width,
      );
      if (seg.hardBreak) wrapped[wrapped.length - 1] += seg.hardBreak;
      out.push(...wrapped);
    }
    para = null;
  };

  const appendToPara = (rawLine, content) => {
    const hardBreak = hardBreakSuffix(content);
    const body = (hardBreak ? content.slice(0, -hardBreak.length) : content).trim();
    para.rawLines.push(rawLine);
    const last = para.segments[para.segments.length - 1];
    if (last && !last.hardBreak) {
      last.text = last.text ? `${last.text} ${body}` : body;
      last.hardBreak = hardBreak;
    } else {
      para.segments.push({ text: body, hardBreak });
    }
  };

  for (let idx = 0; idx < allLines.length; idx += 1) {
    const line = allLines[idx];
    const r = step(line);
    if (r.kind !== "text" || r.code) {
      flush();
      inTable = false;
      out.push(line);
      continue;
    }

    const qm = /^((?: {0,3}>[ ]?)+)/.exec(line);
    const quotePrefix = qm ? qm[1] : "";
    const afterQuote = line.slice(quotePrefix.length);

    if (formatTables && idx + 1 < allLines.length) {
      const lead = /^([ ]*)(.*)$/.exec(afterQuote);
      const headerCells = splitTableRow(lead[2]);
      const nextLine = allLines[idx + 1];
      const nqm = /^((?: {0,3}>[ ]?)+)/.exec(nextLine);
      const nextQuote = nqm ? nqm[1] : "";
      if (headerCells && nextQuote === quotePrefix) {
        const delimCells = splitTableRow(nextLine.slice(nextQuote.length));
        const alignments = parseTableDelimiter(delimCells);
        if (alignments && alignments.length === headerCells.length) {
          flush();
          inTable = false;
          step(nextLine);
          idx += 1;
          const rows = [headerCells];
          while (idx + 1 < allLines.length) {
            const bodyLine = allLines[idx + 1];
            const bqm = /^((?: {0,3}>[ ]?)+)/.exec(bodyLine);
            const bodyQuote = bqm ? bqm[1] : "";
            if (bodyQuote !== quotePrefix) break;
            const bodyAfter = bodyLine.slice(bodyQuote.length);
            if (
              !bodyAfter.trim() ||
              THEMATIC_BREAK.test(bodyAfter) ||
              ATX_HEADING.test(bodyAfter) ||
              HTML_LINE.test(bodyAfter) ||
              /^[ ]{0,3}(?:`{3,}|~{3,})/.test(bodyAfter)
            ) {
              break;
            }
            const bodyCells = splitTableRow(bodyAfter);
            if (!bodyCells) break;
            step(bodyLine);
            rows.push(bodyCells);
            idx += 1;
          }
          out.push(...formatTable(quotePrefix + lead[1], rows, alignments));
          continue;
        }
      }
    }

    // Keep Setext heading lines and their underline untouched.
    if (
      para &&
      !para.isList &&
      para.quotePrefix === quotePrefix &&
      SETEXT_UNDERLINE.test(afterQuote)
    ) {
      out.push(...para.rawLines, line);
      para = null;
      inTable = false;
      continue;
    }

    const isTableSep =
      TABLE_SEP.test(afterQuote) || SINGLE_COL_TABLE_SEP.test(afterQuote);
    if (isTableSep) {
      if (
        para &&
        para.rawLines.length === 1 &&
        para.quotePrefix === quotePrefix &&
        hasUnescapedPipe(para.rawLines[0])
      ) {
        out.push(...para.rawLines, line);
        para = null;
      } else {
        flush();
        out.push(line);
      }
      inTable = true;
      continue;
    }

    if (
      /^[ \t]*\|/.test(afterQuote) ||
      (inTable && hasUnescapedPipe(afterQuote))
    ) {
      flush();
      inTable = true;
      out.push(line);
      continue;
    }
    inTable = false;

    if (
      THEMATIC_BREAK.test(afterQuote) ||
      ATX_HEADING.test(afterQuote) ||
      REF_LINK_DEF.test(afterQuote) ||
      HTML_LINE.test(afterQuote)
    ) {
      flush();
      out.push(line);
      continue;
    }

    const listMatch = /^([ ]*)([-*+]|\d{1,9}[.)])([ ]+)(.*)$/.exec(afterQuote);
    if (listMatch) {
      flush();
      const [, indent, marker, sep, content] = listMatch;
      const firstPrefix = quotePrefix + indent + marker + sep;
      const contPrefix =
        quotePrefix + " ".repeat(indent.length + marker.length + sep.length);
      para = {
        quotePrefix,
        firstPrefix,
        contPrefix,
        isList: true,
        rawLines: [],
        segments: [],
      };
      appendToPara(line, content);
      continue;
    }

    if (para && para.quotePrefix === quotePrefix) {
      appendToPara(line, afterQuote);
      continue;
    }

    flush();
    const leadMatch = /^([ ]*)(.*)$/.exec(afterQuote);
    const prefix = quotePrefix + leadMatch[1];
    para = {
      quotePrefix,
      firstPrefix: prefix,
      contPrefix: prefix,
      isList: false,
      rawLines: [],
      segments: [],
    };
    appendToPara(line, leadMatch[2]);
  }

  flush();
  return out.join(eol);
}

// Hard-wraps markdown prose paragraphs to `width` columns while leaving code
// blocks, tables, headings, thematic breaks, HTML lines, reference link
// definitions, and hard line breaks untouched.
export function wrapMarkdown(text, width = 88) {
  return reflowMarkdown(text, width, false);
}

// Hard-wraps markdown prose paragraphs to `width` columns and pretty-prints
// GFM markdown tables while leaving code blocks, headings, thematic breaks,
// HTML lines, reference link definitions, and hard line breaks untouched.
export function formatMarkdown(text, width = 88) {
  return reflowMarkdown(text, width, true);
}

// ---------------------------------------------------------------- editor highlighting
//
// Maps file paths onto EditorState's `language` option. Only extensions that
// EditorState does not highlight under their own name are aliased here
// (verified live in Herdr: js/javascript, py/python/pyi, rs/rust, go, json,
// bash/sh, yaml/yml, css, sql, c/h, cpp/hpp/cc/cxx/hh/hxx, java, rb/ruby, cs,
// php, lua, makefile/make/mk, perl/pl, scala, haskell/hs, ocaml/ml/mli, r,
// clj, erl, tex, bat, groovy, lisp/el, and tcl highlight natively; markdown/md
// and html/xml do not).

const EDITOR_LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  jsonc: "json",
  toml: "yaml",
  scss: "css",
  sass: "css",
  less: "css",
  zsh: "bash",
  ksh: "bash",
  shell: "bash",
};

const EDITOR_FILES = {
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "bash",
  ".zprofile": "bash",
  ".profile": "bash",
};

// Resolves a file path to the EditorState language name that best highlights it.
export function editorLanguage(path) {
  if (!path) return "txt";
  const base = path.split(/[\\/]/).pop().toLowerCase();
  if (Object.hasOwn(EDITOR_FILES, base)) return EDITOR_FILES[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "txt";
  const ext = base.slice(dot + 1);
  return Object.hasOwn(EDITOR_LANG, ext) ? EDITOR_LANG[ext] : ext;
}

// ---------------------------------------------------------------- line syntax coloring
//
// Tokenizes one line of code into `[[text, kind], ...]` runs for Comment mode
// and diffs using EditorState's seven color roles (`comment`, `string`,
// `keyword`, `fn`, `type`, `number`, `const`, or null). Adjacent runs with the
// same role merge, and joining the runs always reproduces `line` verbatim.

const WORDS = (s) => new Set(s.split(" "));

const JS_KW = WORDS(
  "async await break case catch class const continue debugger default delete " +
    "do else export extends finally for from function get if import in " +
    "instanceof let new of return set static super switch throw try typeof " +
    "var void while with yield interface type enum implements namespace " +
    "readonly public private protected abstract as satisfies",
);
const PY_KW = WORDS(
  "and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass " +
    "raise return try while with yield match case",
);
const GO_KW = WORDS(
  "break case chan const continue default defer else fallthrough for func go " +
    "goto if import interface map package range return select struct switch " +
    "type var",
);
const RS_KW = WORDS(
  "as async await break const continue crate dyn else enum extern fn for if " +
    "impl in let loop match mod move mut pub ref return static struct super " +
    "trait type unsafe use where while",
);
const SH_KW = WORDS(
  "if then else elif fi case esac for select while until do done in function " +
    "time coproc return exit break continue local export readonly declare " +
    "typeset unset shift trap set",
);
const C_KW = WORDS(
  "auto break case catch class const constexpr continue default delete do " +
    "else enum explicit extern final for friend goto if inline mutable " +
    "namespace new noexcept operator override private protected public " +
    "register reinterpret_cast return sizeof static static_cast struct " +
    "switch template throw try typedef typename union using virtual void " +
    "volatile while",
);

const GRAMMARS = {
  js: {
    slash: true,
    block: true,
    quotes: "\"'`",
    at: true,
    kw: JS_KW,
    consts: WORDS("true false null undefined this arguments NaN Infinity"),
    types: WORDS("boolean number string symbol bigint any unknown never object"),
  },
  py: {
    hash: true,
    quotes: "\"'",
    at: true,
    kw: PY_KW,
    consts: WORDS("True False None self cls Ellipsis NotImplemented"),
    types: WORDS(
      "int float str bytes bool list dict set tuple object Callable Optional Any",
    ),
  },
  go: {
    slash: true,
    block: true,
    quotes: "\"'`",
    kw: GO_KW,
    consts: WORDS("true false nil iota"),
    types: WORDS(
      "bool byte complex64 complex128 error float32 float64 int int8 int16 " +
        "int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any " +
        "comparable",
    ),
  },
  rs: {
    slash: true,
    block: true,
    quotes: '"',
    rsAttr: true,
    rsQuote: true,
    kw: RS_KW,
    consts: WORDS("true false None Some Ok Err self Self"),
    types: WORDS(
      "bool char str i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize " +
        "f32 f64 String Vec Box Rc Arc Option Result",
    ),
  },
  sh: {
    hash: true,
    quotes: "\"'`",
    dollar: true,
    kw: SH_KW,
    consts: WORDS("true false"),
    types: new Set(),
  },
  c: {
    slash: true,
    block: true,
    quotes: "\"'",
    at: true,
    kw: C_KW,
    consts: WORDS("true false nullptr NULL this"),
    types: WORDS(
      "int long short char void float double bool size_t ssize_t uint8_t " +
        "uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t string",
    ),
  },
  data: {
    hash: true,
    slash: true,
    quotes: "\"'",
    keys: true,
    kw: new Set(),
    consts: WORDS("true false null yes no on off"),
    types: new Set(),
  },
  css: {
    slash: true,
    block: true,
    quotes: "\"'",
    cssBangAt: true,
    kw: WORDS("@media @import @keyframes @supports @layer !important"),
    consts: WORDS(
      "none auto inherit initial unset solid flex grid block inline relative " +
        "absolute fixed",
    ),
    types: new Set(),
  },
};

const EXT_GRAMMAR = {
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  ts: "js",
  mts: "js",
  cts: "js",
  tsx: "js",
  py: "py",
  pyi: "py",
  go: "go",
  rs: "rs",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  hpp: "c",
  java: "c",
  kt: "c",
  swift: "c",
  cs: "c",
  json: "data",
  jsonc: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  css: "css",
  scss: "css",
};

const isIdentStart = (c) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdent = (c) => isIdentStart(c) || (c >= "0" && c <= "9");
const isDigit = (c) => c >= "0" && c <= "9";

function makeSpanPusher() {
  const out = [];
  const push = (s, k) => {
    if (!s) return;
    if (out.length && out[out.length - 1][1] === k) out[out.length - 1][0] += s;
    else out.push([s, k]);
  };
  return { out, push };
}

function tokenizeMarkdownLine(line) {
  if (/^\s*#{1,6}(\s|$)/.test(line)) return [[line, "keyword"]];
  if (/^\s*(`{3,}|~{3,})/.test(line)) return [[line, "comment"]];
  const { out, push } = makeSpanPusher();
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== "`") j++;
      const end = j < line.length ? j + 1 : j;
      push(line.slice(i, end), "string");
      i = end;
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j] !== "`") j++;
    push(line.slice(i, j), null);
    i = j;
  }
  return out.length ? out : [[line, null]];
}

function tokenizeMarkupLine(line) {
  const { out, push } = makeSpanPusher();
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      const to = end < 0 ? line.length : end + 3;
      push(line.slice(i, to), "comment");
      i = to;
      continue;
    }
    if (line[i] === "<" && (line[i + 1] === "/" || isIdentStart(line[i + 1] ?? ""))) {
      let j = i + (line[i + 1] === "/" ? 2 : 1);
      while (
        j < line.length &&
        (isIdent(line[j]) || line[j] === "-" || line[j] === ":")
      ) {
        j++;
      }
      push(line.slice(i, j), "keyword");
      i = j;
      while (i < line.length && line[i] !== ">") {
        if (line[i] === '"' || line[i] === "'") {
          const q = line[i];
          let k = i + 1;
          while (k < line.length && line[k] !== q) k++;
          const end = k < line.length ? k + 1 : k;
          push(line.slice(i, end), "string");
          i = end;
        } else if (isIdentStart(line[i])) {
          let k = i + 1;
          while (
            k < line.length &&
            (isIdent(line[k]) || line[k] === "-" || line[k] === ":")
          ) {
            k++;
          }
          push(line.slice(i, k), "type");
          i = k;
        } else {
          push(line[i], null);
          i++;
        }
      }
      if (line[i] === ">") {
        push(">", "keyword");
        i++;
      }
      continue;
    }
    let j = i + 1;
    while (j < line.length && line[j] !== "<") j++;
    push(line.slice(i, j), null);
    i = j;
  }
  return out.length ? out : [[line, null]];
}

export function tokenizeLine(line, ext) {
  if (!line || !ext) return [[line, null]];
  const e = ext.toLowerCase();
  if (e === "md" || e === "markdown" || e === "mdx") {
    return tokenizeMarkdownLine(line);
  }
  if (
    e === "html" ||
    e === "xml" ||
    e === "svg" ||
    e === "vue" ||
    e === "svelte"
  ) {
    return tokenizeMarkupLine(line);
  }
  const g = GRAMMARS[EXT_GRAMMAR[e]];
  if (!g) return [[line, null]];

  const { out, push } = makeSpanPusher();
  const hyphenIdent = e === "css" || e === "scss";
  let i = 0;
  let prevWord = "";

  // Bare key at the start of a YAML/TOML line (`name: value` or `name = value`).
  if (g.keys && e !== "json" && e !== "jsonc") {
    const m = /^(\s*)([A-Za-z0-9_.-]+)(\s*[:=])/.exec(line);
    if (m) {
      push(m[1], null);
      push(m[2], "fn");
      push(m[3], null);
      i = m[0].length;
    }
  }

  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1] ?? "";
    if (g.slash && c === "/" && next === "/") {
      push(line.slice(i), "comment");
      break;
    }
    if (g.block && c === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      const to = end < 0 ? line.length : end + 2;
      push(line.slice(i, to), "comment");
      i = to;
      continue;
    }
    if (g.rsAttr && c === "#" && (next === "[" || (next === "!" && line[i + 2] === "["))) {
      const end = line.indexOf("]", i + 2);
      const to = end < 0 ? line.length : end + 1;
      push(line.slice(i, to), "type");
      i = to;
      continue;
    }
    if (g.hash && c === "#" && (i === 0 || /\s/.test(line[i - 1])) && e !== "json") {
      push(line.slice(i), "comment");
      break;
    }
    if (g.quotes.includes(c)) {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      const isKey = g.keys && c === '"' && /^\s*:/.test(line.slice(j));
      push(line.slice(i, j), isKey ? "fn" : "string");
      i = j;
      continue;
    }
    if (g.rsQuote && c === "'") {
      const closeQuote = line.indexOf("'", i + 2);
      if (line[i + 1] === "\\" && closeQuote > i && closeQuote <= i + 6) {
        const end = closeQuote + 1;
        push(line.slice(i, end), "string");
        i = end;
        continue;
      }
      if (line[i + 2] === "'") {
        push(line.slice(i, i + 3), "string");
        i += 3;
        continue;
      }
      if (isIdentStart(next)) {
        let j = i + 2;
        while (j < line.length && isIdent(line[j])) j++;
        push(line.slice(i, j), "type");
        i = j;
        continue;
      }
    }
    if (g.cssBangAt && (c === "@" || c === "!") && isIdentStart(next)) {
      let j = i + 2;
      while (j < line.length && (isIdent(line[j]) || line[j] === "-")) j++;
      const word = line.slice(i, j);
      push(word, g.kw.has(word) ? "keyword" : null);
      i = j;
      continue;
    }
    if (g.at && c === "@" && isIdentStart(next)) {
      let j = i + 2;
      while (j < line.length && (isIdent(line[j]) || line[j] === ".")) j++;
      push(line.slice(i, j), "type");
      i = j;
      continue;
    }
    if (g.dollar && c === "$" && (next === "{" || isIdentStart(next) || isDigit(next))) {
      if (next === "{") {
        const end = line.indexOf("}", i + 2);
        const to = end < 0 ? line.length : end + 1;
        push(line.slice(i, to), "const");
        i = to;
      } else {
        let j = i + 2;
        while (j < line.length && isIdent(line[j])) j++;
        push(line.slice(i, j), "const");
        i = j;
      }
      continue;
    }
    if (isDigit(c) && (i === 0 || !isIdent(line[i - 1]))) {
      let j = i + 1;
      if (c === "0" && "xXbBoO".includes(line[j] ?? "")) {
        j += 1;
        while (j < line.length && /[0-9a-fA-F_]/.test(line[j])) j++;
      } else {
        while (j < line.length && (isDigit(line[j]) || line[j] === "_")) j++;
        if (line[j] === "." && isDigit(line[j + 1] ?? "")) {
          j += 1;
          while (j < line.length && (isDigit(line[j]) || line[j] === "_")) j++;
        }
        if ("eE".includes(line[j] ?? "")) {
          let k = j + 1;
          if (line[k] === "+" || line[k] === "-") k++;
          if (isDigit(line[k] ?? "")) {
            j = k + 1;
            while (j < line.length && isDigit(line[j])) j++;
          }
        }
      }
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < line.length && (isIdent(line[j]) || (hyphenIdent && line[j] === "-"))) {
        j++;
      }
      const word = line.slice(i, j);
      const defFn =
        prevWord === "fn" ||
        prevWord === "func" ||
        prevWord === "def" ||
        prevWord === "function";
      const call =
        defFn ||
        line[j] === "(" ||
        (e === "rs" && line[j] === "!" && line[j + 1] === "(");
      const kind = g.kw.has(word)
        ? "keyword"
        : g.consts.has(word) || (word.length >= 2 && /^[A-Z][A-Z0-9_]+$/.test(word))
          ? "const"
          : g.types.has(word) || /^[A-Z][a-zA-Z0-9]*$/.test(word)
            ? "type"
            : call
              ? "fn"
              : null;
      push(word, kind);
      prevWord = word;
      i = j;
      continue;
    }
    if (c !== " " && c !== "\t") prevWord = "";
    let j = i + 1;
    while (j < line.length) {
      const ch = line[j];
      if (
        isIdentStart(ch) ||
        isDigit(ch) ||
        ch === "/" ||
        ch === "#" ||
        ch === "@" ||
        ch === "!" ||
        ch === "$" ||
        ch === "'" ||
        g.quotes.includes(ch)
      ) {
        break;
      }
      if (ch !== " " && ch !== "\t") prevWord = "";
      j += 1;
    }
    push(line.slice(i, j), null);
    i = j;
  }
  return out.length ? out : [[line, null]];
}
