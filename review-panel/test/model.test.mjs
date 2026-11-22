// Run with: node --test review-panel/test/model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  untab,
  fileRows,
  diffRows,
  selection,
  lines,
  where,
  editorLines,
  locate,
  outdated,
  sortComments,
  shortQuote,
  formatReview,
  stateOf,
  unsent,
  replyFolder,
  parseReply,
  applyReply,
  markSent,
  DAY,
  newSet,
  findSet,
  migrate,
  sweep,
  adoptable,
  attach,
  isMarkdown,
  markdownBlocks,
  bareFences,
  blockFor,
  textKey,
  pictureFile,
  liftPictures,
  splitMarkdown,
  editorLanguage,
  tokenizeLine,
  wrapSpans,
  wrapMarkdown,
  formatMarkdown,
  machineOf,
  sameSize,
  samePanel,
} from "../model.js";

const DIFF = [
  "@@ -10,5 +10,6 @@ def load(path):",
  " def load(path):",
  "-    return open(path).read()",
  "+    f = open(path)",
  "+    return f.read()",
  " ",
  " def save(path, text):",
  "@@ -40,3 +41,2 @@",
  " import os",
  "-import sys",
  " import re",
  "\\ No newline at end of file",
];

test("untab pads to 4-column stops", () => {
  assert.equal(untab("\tx"), "    x");
  assert.equal(untab("ab\tx"), "ab  x");
  assert.equal(untab("no tabs"), "no tabs");
});

test("fileRows numbers lines and drops the final newline and carriage returns", () => {
  assert.deepEqual(fileRows("a\r\nb\n"), [
    { kind: " ", n: 1, text: "a" },
    { kind: " ", n: 2, text: "b" },
  ]);
  assert.deepEqual(fileRows(""), [{ kind: " ", n: 1, text: "" }]);
});

test("diffRows numbers added and kept lines by the new file, removed lines by the old", () => {
  const rows = diffRows(DIFF);
  assert.deepEqual(
    rows.map((r) => `${r.kind}${r.n ?? ""}`),
    ["@", " 10", "-11", "+11", "+12", " 13", " 14", "@", " 41", "-41", " 42", ""],
  );
  assert.equal(rows[2].text, "    return open(path).read()");
  assert.equal(rows[5].text, "");
});

test("diffRows strips trailing carriage returns so CRLF quotes match fileRows", () => {
  const crlfDiff = ["@@ -1,1 +1,2 @@\r", " alpha\r", "+beta\r"];
  const dRows = diffRows(crlfDiff);
  const picked = selection(dRows, 1, 2, "a.txt");
  assert.deepEqual(picked.quote, ["alpha", "beta"]);
  assert.equal(outdated(picked, fileRows("alpha\r\nbeta\r\n")), false);
});

test("selection of current lines gives their range and plain text, in either order", () => {
  const rows = diffRows(DIFF);
  const want = {
    path: "a.py",
    from: 11,
    to: 12,
    removed: false,
    mixed: false,
    gap: false,
    quote: ["    f = open(path)", "    return f.read()"],
  };
  assert.deepEqual(selection(rows, 3, 4, "a.py"), want);
  assert.deepEqual(selection(rows, 4, 3, "a.py"), want);
});

test("selection of only removed lines uses the old numbers", () => {
  const got = selection(diffRows(DIFF), 2, 2, "a.py");
  assert.equal(got.removed, true);
  assert.equal(lines(got), "11 (removed)");
  assert.deepEqual(got.quote, ["    return open(path).read()"]);
});

test("selection mixing removed and current lines marks each quoted line", () => {
  const got = selection(diffRows(DIFF), 1, 3, "a.py");
  assert.deepEqual([got.from, got.to, got.removed, got.mixed], [10, 11, false, true]);
  assert.deepEqual(got.quote, [
    " def load(path):",
    "-    return open(path).read()",
    "+    f = open(path)",
  ]);
});

test("selection across two hunks notes the lines it skips", () => {
  const got = selection(diffRows(DIFF), 6, 8, "a.py");
  assert.deepEqual([got.from, got.to, got.gap], [14, 41, true]);
  assert.deepEqual(got.quote, ["def save(path, text):", "…", "import os"]);
});

test("selection of rows that are not lines is nothing", () => {
  assert.equal(selection(diffRows(DIFF), 0, 0, "a.py"), null);
  assert.equal(selection(diffRows(DIFF), 11, 11, "a.py"), null);
});

test("selection starting on a hunk header does not count as crossing one", () => {
  const got = selection(diffRows(DIFF), 0, 1, "a.py");
  assert.deepEqual([got.from, got.to, got.gap], [10, 10, false]);
});

test("where names the file and lines", () => {
  assert.equal(where({ path: "a.py", from: 3, to: 3 }), "a.py:3");
  assert.equal(where({ path: "a.py", from: 3, to: 9 }), "a.py:3-9");
  assert.equal(where({ path: "a.py", from: 3, to: 4, removed: true }), "a.py:3-4 (removed)");
});

test("locate finds the comment's last line on the right side of the diff", () => {
  const rows = diffRows(DIFF);
  assert.equal(locate({ from: 11, to: 12 }, rows), 4);
  assert.equal(locate({ from: 11, to: 11, removed: true }, rows), 2);
  assert.equal(locate({ from: 41, to: 41 }, rows), 8);
  assert.equal(locate({ from: 41, to: 41, removed: true }, rows), 9);
  assert.equal(locate({ from: 99, to: 99 }, rows), -1);
  assert.equal(locate({ from: 2, to: 2, removed: true }, fileRows("a\nb\nc")), -1);
});

test("outdated is true only when all the lines are shown and differ", () => {
  const c = { from: 2, to: 3, quote: ["b", "c"] };
  assert.equal(outdated(c, fileRows("a\nb\nc\nd")), false);
  assert.equal(outdated(c, fileRows("a\nb\nC\nd")), true);
  assert.equal(outdated(c, fileRows("a\nb")), false);
  assert.equal(outdated({ ...c, mixed: true }, fileRows("a\nX\nY")), false);
  assert.equal(outdated({ ...c, removed: true }, fileRows("a\nX\nY")), false);
});

test("sortComments orders by file, then line, then id", () => {
  const list = [
    { id: "c10", path: "b", from: 1 },
    { id: "c2", path: "a", from: 9 },
    { id: "c3", path: "a", from: 2 },
    { id: "c1", path: "b", from: 1 },
  ];
  assert.deepEqual(
    sortComments(list).map((c) => c.id),
    ["c3", "c2", "c1", "c10"],
  );
});

test("shortQuote keeps the first and last four lines of a long quote", () => {
  const quote = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  assert.deepEqual(shortQuote(quote), [
    "l1",
    "l2",
    "l3",
    "l4",
    "… (22 more lines)",
    "l27",
    "l28",
    "l29",
    "l30",
  ]);
  assert.equal(shortQuote(quote.slice(0, 10)).length, 10);
});

test("formatReview writes the message the agent gets", () => {
  const text = formatReview({
    root: "/repo",
    note: " Fix these, then run the tests. ",
    comments: [
      {
        id: "c2",
        path: "README.md",
        from: 3,
        to: 3,
        quote: ["Run `make all`"],
        text: "The target is `make build`.\n",
      },
      {
        id: "c1",
        path: "src/app.py",
        from: 12,
        to: 14,
        quote: ["f = open(path)", "", "return f.read()"],
        text: "Close the file;\nuse a with block.",
      },
    ],
  });
  assert.equal(
    text,
    [
      "Review comments (2 files) in /repo",
      "",
      "Fix these, then run the tests.",
      "",
      "[c2] README.md:3",
      "> Run `make all`",
      "The target is `make build`.",
      "",
      "[c1] src/app.py:12-14",
      "> f = open(path)",
      ">",
      "> return f.read()",
      "Close the file;",
      "use a with block.",
    ].join("\n"),
  );
});

test("formatReview with one file and no note", () => {
  const text = formatReview({
    root: "/repo",
    note: "",
    comments: [
      { id: "c1", path: "a", from: 1, to: 1, removed: true, quote: ["x"], text: "why?" },
    ],
  });
  assert.equal(text, "Review comments (1 file) in /repo\n\n[c1] a:1 (removed)\n> x\nwhy?");
});

test("formatReview asks for replies when given a folder, and marks follow-ups and reopened comments", () => {
  const text = formatReview({
    root: "/repo",
    note: "",
    replies: "/home/me/.herdr/review/repo-abc123",
    comments: [
      { id: "c3", path: "a", from: 1, to: 1, quote: ["x"], text: "new comment" },
      {
        id: "c1",
        path: "a",
        from: 5,
        to: 5,
        quote: ["y"],
        text: "first comment",
        state: "open",
        reply: "Not what I meant.",
      },
      {
        id: "c2",
        path: "b",
        from: 2,
        to: 2,
        quote: ["z"],
        text: "second comment",
        state: "open",
        resend: true,
      },
    ],
  });
  assert.equal(
    text,
    [
      "Review comments (2 files) in /repo",
      "Reply to each comment by writing a file named after its id, such as c3.md, in /home/me/.herdr/review/repo-abc123/",
      'Start the file with the line "Status: resolved" if the comment is dealt with, or "Status: open" if you need my answer. Then your reply.',
      "",
      "[c3] a:1",
      "> x",
      "new comment",
      "",
      "[c1] a:5 (follow-up)",
      "> y",
      "Not what I meant.",
      "",
      "[c2] b:2 (reopened)",
      "> z",
      "second comment",
    ].join("\n"),
  );
});

test("unsent is the drafts, the follow-ups and the reopened", () => {
  const list = [
    { id: "c1" },
    { id: "c2", state: "open" },
    { id: "c3", state: "open", reply: "more" },
    { id: "c4", state: "open", resend: true },
    { id: "c5", state: "resolved" },
    { id: "c6", state: "draft" },
  ];
  assert.deepEqual(
    unsent(list).map((c) => c.id),
    ["c1", "c3", "c4", "c6"],
  );
  assert.equal(stateOf(list[0]), "draft");
});

test("replyFolder is inside the reviewed folder", () => {
  assert.equal(
    replyFolder("/Users/me/work/repo", "0a1b2c3d"),
    "/Users/me/work/repo/.herdr/review/0a1b2c3d",
  );
  assert.equal(
    replyFolder("/Users/me/work/repo/", "0a1b2c3d"),
    "/Users/me/work/repo/.herdr/review/0a1b2c3d",
  );
});

test("parseReply reads the status line, however it is dressed", () => {
  assert.deepEqual(parseReply("Status: resolved\nFixed with a with block.\n"), {
    status: "resolved",
    text: "Fixed with a with block.",
  });
  assert.deepEqual(
    parseReply("**Status:** open\r\n\r\nWhich target did you mean?"),
    { status: "open", text: "Which target did you mean?" },
  );
  assert.deepEqual(parseReply("status: Resolved"), { status: "resolved", text: "" });
  assert.deepEqual(parseReply("Status: done - see below\nok"), {
    status: "resolved",
    text: "ok",
  });
  assert.deepEqual(parseReply("Just an answer.\nStatus: resolved"), {
    status: null,
    text: "Just an answer.\nStatus: resolved",
  });
});

test("applyReply adds the reply once and sets the state", () => {
  const c = { id: "c1", state: "open", text: "why?" };
  assert.equal(applyReply(c, "Status: resolved\nFixed.", 1), true);
  assert.deepEqual(
    [c.state, c.thread],
    ["resolved", [{ by: "agent", text: "Fixed.", at: 1 }]],
  );
  // Re-reading the same file before re-sending leaves reopened state intact.
  c.state = "open";
  c.resend = true;
  assert.equal(applyReply(c, "Status: resolved\nFixed.", 2), false);
  assert.equal(c.state, "open");
  // A rewritten reply replaces the agent's last one. A reply after mine appends.
  assert.equal(applyReply(c, "Status: open\nFixed, I think?", 3), true);
  assert.deepEqual(c.thread, [{ by: "agent", text: "Fixed, I think?", at: 3 }]);
  c.thread.push({ by: "me", text: "No.", at: 4 });
  applyReply(c, "Status: resolved\nNow fixed.", 5);
  assert.deepEqual(
    c.thread.map((m) => m.by),
    ["agent", "me", "agent"],
  );
  assert.equal(c.state, "resolved");

  // A new resolved reply clears resend. A queued follow-up keeps the comment open.
  c.state = "open";
  c.resend = true;
  applyReply(c, "Status: resolved\nDone again.", 6);
  assert.equal(c.state, "resolved");
  assert.equal(c.resend, undefined);
  c.reply = "One more thing.";
  applyReply(c, "Status: resolved\nUpdated.", 7);
  assert.equal(c.state, "open");
  assert.equal(c.resolvedAt, undefined);
});

test("applyReply ignores drafts, empty files, and leaves the state alone without a status line", () => {
  assert.equal(applyReply({ id: "c1" }, "Status: resolved\nx", 1), false);
  const c = { id: "c2", state: "open" };
  assert.equal(applyReply(c, "  \n", 1), false);
  assert.equal(applyReply(c, "Looking into it.", 1), true);
  assert.equal(c.state, "open");
});

test("markSent opens everything sent and moves follow-ups into the thread", () => {
  const list = [
    { id: "c1" },
    {
      id: "c2",
      state: "resolved",
      reply: "again",
      resend: true,
      thread: [{ by: "agent", text: "done", at: 1 }],
    },
    {
      id: "c3",
      state: "open",
      resend: true,
      thread: [{ by: "agent", text: "fixed", at: 1 }],
    },
  ];
  markSent(list, 9);
  assert.deepEqual(list[0], { id: "c1", state: "open" });
  assert.deepEqual(list[1], {
    id: "c2",
    state: "open",
    thread: [
      { by: "agent", text: "done", at: 1 },
      { by: "me", text: "again", at: 9 },
    ],
  });
  assert.deepEqual(list[2].thread[1], { by: "me", text: "Reopened.", at: 9 });
  applyReply(list[2], "Status: resolved\nfixed properly", 10);
  assert.deepEqual(
    list[2].thread.map((m) => m.text),
    ["fixed", "Reopened.", "fixed properly"],
  );
});

// ---------------------------------------------------------------- sets

const tabs = (map) => (id) => map[id];
const always = () => true;

test("findSet is per tab, machine and folder", () => {
  const sets = [
    newSet("t1", null, "/a", "k1"),
    newSet("t2", null, "/a", "k2"),
    newSet("t1", "vps", "/a", "k3"),
    newSet("t1", null, "/b", "k4"),
  ];
  assert.equal(findSet(sets, "t1", null, "/a").key, "k1");
  assert.equal(findSet(sets, "t2", null, "/a").key, "k2");
  assert.equal(findSet(sets, "t1", "vps", "/a").key, "k3");
  assert.equal(findSet(sets, "t1", undefined, "/b").key, "k4");
  assert.equal(findSet(sets, "t3", null, "/a"), undefined);
});

test("migrate turns the old per-folder store into closed sets", () => {
  let n = 0;
  const sets = migrate(
    {
      "|/repo": { seq: 4, note: "", comments: [{ id: "c2" }] },
      "vps|/x": { seq: 1, note: "hi", comments: [] },
      "|/empty": { seq: 3, note: "", comments: [] },
    },
    100,
    () => `k${++n}`,
  );
  assert.deepEqual(
    sets.map((s) => [
      s.key,
      s.tab,
      s.on,
      s.root,
      s.seq,
      s.closedAt,
      s.comments.length,
    ]),
    [
      ["k1", null, null, "/repo", 4, 100, 1],
      ["k2", null, "vps", "/x", 1, 100, 0],
    ],
  );
});

test("sweep follows tab names and marks a set closed when its tab is gone", () => {
  const set = { ...newSet("t1", null, "/a", "k1"), comments: [{ id: "c1" }] };
  const sets = [set];
  assert.equal(
    sweep(sets, tabs({ t1: { name: "fix login", named: true } }), always, 10),
    true,
  );
  assert.deepEqual([set.name, set.named, set.closedAt], ["fix login", true, undefined]);
  assert.equal(
    sweep(sets, tabs({ t1: { name: "fix login", named: true } }), always, 11),
    false,
  );
  assert.equal(sweep(sets, tabs({}), () => false, 12), false);
  assert.equal(set.closedAt, undefined);
  assert.equal(sweep(sets, tabs({}), always, 13), true);
  assert.equal(set.closedAt, 13);
  sweep(sets, tabs({ t1: { name: "fix login", named: true } }), always, 14);
  assert.equal(set.closedAt, undefined);
});

test("sweep clears closed sets after 30 days, empty closed sets at once, and old resolved comments", () => {
  const old = {
    ...newSet("gone", null, "/a", "k1"),
    comments: [{ id: "c1" }],
    closedAt: 1,
  };
  const empty = { ...newSet("gone2", null, "/a", "k2"), closedAt: 30 * DAY };
  const open = {
    ...newSet("t1", null, "/a", "k3"),
    comments: [
      { id: "c1", state: "resolved", resolvedAt: 1 },
      { id: "c2", state: "resolved", resolvedAt: 29 * DAY },
      { id: "c3", state: "open" },
      { id: "c4", state: "resolved" },
    ],
  };
  const sets = [old, empty, open];
  sweep(sets, tabs({ t1: { name: "1", named: false } }), always, 30 * DAY + 2);
  assert.deepEqual(
    sets.map((s) => s.key),
    ["k3"],
  );
  assert.deepEqual(
    open.comments.map((c) => c.id),
    ["c2", "c3", "c4"],
  );
  assert.equal(open.comments[2].resolvedAt, 30 * DAY + 2);

  const loose = newSet("", null, "/a", "k4");
  const legacy = {
    ...newSet(null, null, "/a", "k5"),
    comments: [{ id: "c1" }],
    closedAt: 30 * DAY,
  };
  const more = [loose, legacy];
  sweep(more, tabs({}), always, 30 * DAY + 2);
  assert.deepEqual(
    more.map((s) => [s.key, Boolean(s.closedAt)]),
    [
      ["k4", false],
      ["k5", true],
    ],
  );
});

test("adoptable picks the one closed set whose tab had the same given name", () => {
  const closed = {
    ...newSet("old", null, "/a", "k1"),
    name: "fix login",
    named: true,
    comments: [{ id: "c1" }],
    closedAt: 1,
  };
  const sets = [closed];
  assert.equal(adoptable(sets, "new", "fix login", true, null, "/a"), closed);
  assert.equal(adoptable(sets, "new", "fix login", false, null, "/a"), null);
  assert.equal(adoptable(sets, "new", "other", true, null, "/a"), null);
  assert.equal(adoptable(sets, "new", "fix login", true, null, "/b"), null);
  assert.equal(adoptable(sets, "new", "fix login", true, "vps", "/a"), null);
  sets.push({
    ...newSet("old2", null, "/a", "k2"),
    name: "fix login",
    named: true,
    comments: [{ id: "c1" }],
    closedAt: 2,
  });
  assert.equal(adoptable(sets, "new", "fix login", true, null, "/a"), null);
  sets.pop();
  sets.push({ ...newSet("new", null, "/a", "k3"), comments: [{ id: "c1" }] });
  assert.equal(adoptable(sets, "new", "fix login", true, null, "/a"), null);
  assert.equal(
    adoptable([{ ...closed, named: false }], "new", "fix login", true, null, "/a"),
    null,
  );
});

test("attach hands a closed set to a tab, renumbering when the tab has comments already", () => {
  const closed = () => ({
    ...newSet("old", null, "/a", "k1"),
    seq: 2,
    note: "old note",
    comments: [{ id: "c1", seen: "x" }, { id: "c2" }],
    closedAt: 1,
  });
  let from = closed();
  let sets = [from, newSet("new", null, "/a", "k9")];
  assert.equal(attach(sets, from, "new", null, "/a"), from);
  assert.deepEqual(
    [
      sets.length,
      from.tab,
      from.closedAt,
      from.key,
      from.comments.map((c) => c.id),
    ],
    [1, "new", undefined, "k1", ["c1", "c2"]],
  );

  from = closed();
  const own = { ...newSet("new", null, "/a", "k9"), seq: 5, comments: [{ id: "c5" }] };
  sets = [from, own];
  assert.equal(attach(sets, from, "new", null, "/a"), own);
  assert.deepEqual(
    [
      sets.length,
      own.seq,
      own.comments.map((c) => c.id),
      own.comments[1].seen,
    ],
    [1, 7, ["c5", "c6", "c7"], undefined],
  );
  // Attaching a set that is no longer in `sets` changes nothing.
  const detached = closed();
  assert.equal(attach(sets, detached, "new", null, "/a"), own);
  assert.equal(sets.length, 1);
});

test("applyReply records when a comment was resolved", () => {
  const c = { id: "c1", state: "open" };
  applyReply(c, "Status: resolved\nok", 50);
  assert.equal(c.resolvedAt, 50);
  applyReply(c, "Status: open\nactually no", 60);
  assert.equal(c.resolvedAt, undefined);
});

// ---------------------------------------------------------------- markdown, drawn

const MD = [
  "# Title", // 1
  "", // 2
  "A paragraph that", // 3
  "runs over two lines.", // 4
  "", // 5
  "## Section", // 6
  "- first item", // 7
  "  - nested under it", // 8
  "- second item", // 9
  "", // 10
  "  still the second item", // 11
  "", // 12
  "1. one", // 13
  "2. two", // 14
  "", // 15
  "| a | b |", // 16
  "|---|---|", // 17
  "| 1 | 2 |", // 18
  "", // 19
  "```js", // 20
  "const x = 1;", // 21
  "", // 22
  "# not a heading", // 23
  "```", // 24
  "> a quote", // 25
  "carried on", // 26
  "", // 27
  "```mermaid", // 28
  "graph TD", // 29
  "  A --> B", // 30
  "```", // 31
  "Setext", // 32
  "------", // 33
  "---", // 34
  "last line", // 35
].join("\n");

test("markdownBlocks splits a file into the blocks a reader sees, with their lines", () => {
  const blocks = markdownBlocks(MD + "\n");
  assert.deepEqual(
    blocks.map((b) => `${b.kind} ${b.from}-${b.to}`),
    [
      "md 1-1",
      "md 3-4",
      "md 6-6",
      "md 7-8",
      "md 9-11",
      "md 13-13",
      "md 14-14",
      "md 16-18",
      "md 20-24",
      "md 25-26",
      "mermaid 28-31",
      "md 32-33",
      "md 34-34",
      "md 35-35",
    ],
  );
  assert.equal(blocks[1].text, "A paragraph that\nruns over two lines.");
  assert.equal(blocks[4].text, "- second item\n\n  still the second item");
  assert.equal(blocks[8].text.split("\n").length, 5);
  assert.equal(blocks[10].code, "graph TD\n  A --> B");
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i].from > blocks[i - 1].to);
  }
});

test("markdownBlocks keeps an unclosed fence to the end, and handles an empty file", () => {
  const open = markdownBlocks("text\n\n```mermaid\ngraph TD\n  A --> B");
  assert.deepEqual(
    open.map((b) => `${b.kind} ${b.from}-${b.to}`),
    ["md 1-1", "mermaid 3-5"],
  );
  assert.equal(open[1].code, "graph TD\n  A --> B");
  assert.deepEqual(markdownBlocks(""), []);
  assert.deepEqual(markdownBlocks("\n\n"), []);
});

test("blockFor finds the block of a line, or the one before a blank line", () => {
  const blocks = markdownBlocks(MD);
  assert.equal(blockFor(blocks, 4), 1);
  assert.equal(blockFor(blocks, 5), 1);
  assert.equal(blockFor(blocks, 30), 10);
  assert.equal(blockFor(blocks, 99), 13);
  assert.equal(blockFor(markdownBlocks("\n\ntext"), 1), -1);
});

test("bareFences strips opening fence languages, including in lists and quotes, without touching examples", () => {
  assert.equal(bareFences("```sh\ngit clone x\n```"), "```\ngit clone x\n```");
  assert.equal(bareFences('~~~ts title="a.ts"\nconst x = 1;\n~~~'), "~~~\nconst x = 1;\n~~~");
  assert.equal(
    bareFences("1. Link the mod:\n\n   ```sh\n   ./plugin.sh link\n   ```"),
    "1. Link the mod:\n\n   ```\n   ./plugin.sh link\n   ```",
  );
  assert.equal(
    bareFences("1. Link the mod:\n\n    ```python\n    print(1)\n    ```"),
    "1. Link the mod:\n\n    ```\n    print(1)\n    ```",
  );
  assert.equal(
    bareFences('> ```json\n> {"a": 1}\n> ```'),
    '> ```\n> {"a": 1}\n> ```',
  );
  assert.equal(
    bareFences("```text\n> quoted\n> ```\n```\n```js\nx\n```"),
    "```\n> quoted\n> ```\n```\n```\nx\n```",
  );
  assert.equal(
    bareFences("````md\n```sh\necho hi\n```\n````"),
    "````\n```sh\necho hi\n```\n````",
  );
  assert.equal(
    bareFences("```mermaid``` in a sentence\n\n```sh\nls\n```"),
    "```mermaid``` in a sentence\n\n```\nls\n```",
  );
  assert.equal(
    bareFences("Example:\n\n    ```sh\n    echo hi\n    ```"),
    "Example:\n\n    ```sh\n    echo hi\n    ```",
  );
  assert.equal(
    bareFences("1. Heading\n   ---\n\n    ```sh\n    echo hi\n    ```"),
    "1. Heading\n   ---\n\n    ```\n    echo hi\n    ```",
  );
  assert.match(textKey("hello"), /^[0-9a-f]{8}$/);
  assert.equal(textKey("hello"), textKey("hello"));
  assert.notEqual(textKey("hello"), textKey("world"));
});

test("isMarkdown goes by the file name", () => {
  assert.equal(isMarkdown("docs/README.md"), true);
  assert.equal(isMarkdown("a.MDX"), true);
  assert.equal(isMarkdown("a.md.txt"), false);
  assert.equal(isMarkdown(null), false);
});

test("pictureFile finds a picture's file from the folder of the document that names it", () => {
  assert.equal(pictureFile("images/a.png", "/repo/docs"), "/repo/docs/images/a.png");
  assert.equal(
    pictureFile("../images/a%20b.png?raw=1#top", "/repo/docs"),
    "/repo/images/a b.png",
  );
  assert.equal(pictureFile("100%-done.md", "/repo/docs"), "/repo/docs/100%-done.md");
  assert.equal(pictureFile("</abs/a.png>", "/repo"), "/abs/a.png");
  assert.equal(pictureFile("file:///abs/a.png", null), "/abs/a.png");
  assert.equal(pictureFile("file://localhost/abs/a.png", null), "/abs/a.png");
  assert.equal(pictureFile("file://remotehost/abs/a.png", "/repo"), null);
  assert.equal(pictureFile("https://example.com/a.png", "/repo"), null);
  assert.equal(pictureFile("mailto:user@example.com", "/repo"), null);
  assert.equal(pictureFile("//example.com/a.png", "/repo"), null);
  assert.equal(pictureFile("#section", "/repo"), null);
  assert.equal(pictureFile("a.png", null), null);
});

test("liftPictures takes pictures out of a block and says where their files are", () => {
  const wherePic = (src) => pictureFile(src, "/repo/docs");
  assert.deepEqual(liftPictures("![Alone](a.png)", wherePic), {
    text: "",
    pictures: [{ path: "/repo/docs/a.png", src: "a.png", alt: "Alone", width: null }],
  });
  assert.equal(
    liftPictures("See ![the shot](a.png) here.", wherePic).text,
    "See the shot here.",
  );
  const two = liftPictures(
    'Intro.\n<img src="a.png" width="233" alt="A"> <img src="../b.png">\nAfter.',
    wherePic,
  );
  assert.equal(two.text, "Intro.\nAfter.");
  assert.deepEqual(
    two.pictures.map((p) => [p.path, p.alt, p.width]),
    [
      ["/repo/docs/a.png", "A", 233],
      ["/repo/b.png", "", null],
    ],
  );
  assert.equal(
    liftPictures("| ![one](a.png) | ![two](b.png) |", wherePic).text,
    "| one | two |",
  );
  const linked = liftPictures("[![badge](a.png)](https://example.com)", wherePic);
  assert.equal(linked.text, "");
  assert.equal(linked.pictures[0].href, "https://example.com");
  const badWidth = liftPictures('<img src="a.png" width="-20"> <img src="b.png" width="1e400">', wherePic);
  assert.deepEqual(badWidth.pictures.map((p) => p.width), [null, null]);
  const listRuleFence = "1. Heading\n   ---\n\n    ```md\n   ![in](a.png)\n    ```";
  assert.deepEqual(liftPictures(listRuleFence, wherePic).pictures, []);
});

test("liftPictures leaves web pictures, code spans and fenced code as written", () => {
  const wherePic = (src) => pictureFile(src, "/repo");
  for (const text of [
    "![web](https://example.com/a.png)",
    "Write `![alt](a.png)` for a picture.",
    "```md\n![alt](a.png)\n```",
    "- item\n\n  ~~~\n  ![alt](a.png)\n  ~~~",
  ]) {
    assert.deepEqual(liftPictures(text, wherePic), { text, pictures: [] });
  }
  assert.equal(
    liftPictures("```\n![in](a.png)\n```\n![out](b.png)", wherePic).pictures.length,
    1,
  );
  assert.equal(
    liftPictures("```mermaid``` blocks:\n![out](b.png)", wherePic).pictures.length,
    1,
  );
  // CommonMark multi-backtick spans close only on a matching backtick run length.
  const multiSpan = liftPictures(
    "``a ``` b`` ![real](b.png) `x`",
    wherePic,
  );
  assert.deepEqual(
    multiSpan.pictures.map((p) => p.path),
    ["/repo/b.png"],
  );
});

test("markdownBlocks gives a block its pictures only when told where files are", () => {
  const text =
    "# Title\n\n![Shot](images/a.png)\n\nText with ![one](b.png) inside.\n\n```mermaid\ngraph TD\n```\n";
  assert.ok(markdownBlocks(text).every((b) => !("pictures" in b) && !("shown" in b)));
  const blocks = markdownBlocks(text, (src) => pictureFile(src, "/repo"));
  assert.deepEqual(
    blocks.map((b) => [
      b.kind,
      b.from,
      b.to,
      b.shown,
      (b.pictures ?? []).map((p) => p.path),
    ]),
    [
      ["md", 1, 1, undefined, []],
      ["md", 3, 3, "", ["/repo/images/a.png"]],
      ["md", 5, 5, "Text with one inside.", ["/repo/b.png"]],
      ["mermaid", 7, 9, undefined, []],
    ],
  );
  assert.equal(blocks[1].text, "![Shot](images/a.png)");
});

test("editorLines maps UTF-16 selections and cursors to 0-based rows without spilling past a trailing newline", () => {
  const text = "alpha\nbeta\ngamma\n";
  assert.deepEqual(editorLines(text, 0, 0, 3), { anchor: 0, head: 0 });
  assert.deepEqual(editorLines(text, 6, 6, 3), { anchor: 1, head: 1 });
  assert.deepEqual(editorLines(text, 6, 11, 3), { anchor: 1, head: 1 });
  assert.deepEqual(editorLines(text, 6, 13, 3), { anchor: 1, head: 2 });
  assert.deepEqual(editorLines(text, 13, 6, 3), { anchor: 1, head: 2 });
  assert.deepEqual(editorLines(text, 99, 99, 3), { anchor: 2, head: 2 });
  assert.deepEqual(editorLines("", 0, 0, 0), { anchor: 0, head: 0 });
});

test("splitMarkdown strips fence languages while keeping mermaid blocks, pictures and inner examples", () => {
  const doc = [
    "1. Link the mod into Herdr's mods folder:",
    "",
    "   ```sh",
    "   git clone https://github.com/kurtisvg/herdr-mods.git",
    "   ```",
    "",
    "![Shot](pic.png)",
    "",
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "````markdown",
    "```sh",
    "echo example",
    "```",
    "````",
  ].join("\n");

  const segs = splitMarkdown(doc, (src) => pictureFile(src, "/dir"));
  assert.deepEqual(
    segs.map((s) => s.kind),
    ["md", "pictures", "mermaid", "md"],
  );
  assert.equal(
    segs[0].text,
    [
      "1. Link the mod into Herdr's mods folder:",
      "",
      "   ```",
      "   git clone https://github.com/kurtisvg/herdr-mods.git",
      "   ```",
      "",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    segs[1].items.map((p) => p.path),
    ["/dir/pic.png"],
  );
  assert.equal(segs[2].code, "flowchart LR\n  A --> B");
  assert.equal(segs[3].text, "\n````\n```sh\necho example\n```\n````");
});

test("splitMarkdown does not mistake inline triple-backtick code, indented code blocks, or nested list fences", () => {
  const wherePic = (src) => pictureFile(src, "/dir");
  const inline = "```mermaid``` blocks become pictures.\n\n![alt](pic.png)";
  const inlineSegs = splitMarkdown(inline, wherePic);
  assert.deepEqual(
    inlineSegs.map((s) => s.kind),
    ["md", "pictures"],
  );
  assert.equal(inlineSegs[0].text, "```mermaid``` blocks become pictures.\n");

  // One-line 4-space indented code block containing ```mermaid does not suppress later pictures.
  const indented = [
    "Example:",
    "",
    "    ```mermaid",
    "    ![example](ignored.png)",
    "",
    "![real](shown.png)",
  ].join("\n");
  const indentedSegs = splitMarkdown(indented, wherePic);
  assert.deepEqual(
    indentedSegs.map((s) => s.kind),
    ["md", "pictures"],
  );
  assert.deepEqual(
    indentedSegs[1].items.map((p) => p.path),
    ["/dir/shown.png"],
  );

  // Nested fences inside a 4-space-indented list item keep inner example pictures untouched.
  const nestedList = [
    "1. Outer list:",
    "",
    "    ````md",
    "    ```md",
    "    ![inner](ignored.png)",
    "    ```",
    "    ````",
    "",
    "![after](real.png)",
  ].join("\n");
  const listSegs = splitMarkdown(nestedList, wherePic);
  assert.deepEqual(
    listSegs.map((s) => s.kind),
    ["md", "pictures"],
  );
  assert.deepEqual(
    listSegs[1].items.map((p) => p.path),
    ["/dir/real.png"],
  );

  // Blank lines inside a fenced code block after an inline picture never split the fence.
  const fenceAfterPic = [
    "See ![shot](pic.png) here:",
    "```python",
    "def foo():",
    "    pass",
    "",
    "def bar():",
    "    pass",
    "```",
  ].join("\n");
  const fenceSegs = splitMarkdown(fenceAfterPic, wherePic);
  assert.deepEqual(
    fenceSegs.map((s) => s.kind),
    ["md", "pictures"],
  );
  assert.equal(
    fenceSegs[0].text,
    "See shot here:\n```\ndef foo():\n    pass\n\ndef bar():\n    pass\n```",
  );
  assert.deepEqual(
    fenceSegs[1].items.map((p) => p.path),
    ["/dir/pic.png"],
  );
});

test("splitMarkdown draws a mermaid fence under a list item and ends it with the item", () => {
  const wherePic = (src) => pictureFile(src, "/repo");
  const kinds = (text) => splitMarkdown(text, wherePic).map((s) => s.kind);

  const bullet = "- item\n\n  ```mermaid\n  graph TD\n  ```\n\n- next";
  const segs = splitMarkdown(bullet, wherePic);
  assert.deepEqual(
    segs.map((s) => [s.kind, s.code ?? s.text, s.open]),
    [
      ["md", "- item\n", undefined],
      ["mermaid", "  graph TD", false],
      ["md", "\n- next", undefined],
    ],
  );
  const numbered = "1. step\n\n   ```mermaid\n   graph TD\n   ```\n\n2. next";
  assert.deepEqual(kinds(numbered), ["md", "mermaid", "md"]);

  // A fence on the line of the list marker, or in a blockquote, stays code.
  assert.deepEqual(kinds("- ```mermaid\n  graph TD\n  ```"), ["md"]);
  assert.deepEqual(kinds("> ```mermaid\n> graph TD\n> ```"), ["md"]);

  // A line at the margin ends the list item, and the unclosed diagram with it.
  const dedent = "- item\n\n  ```mermaid\n  graph TD\nafter\n\n![p](a.png)";
  assert.deepEqual(
    splitMarkdown(dedent, wherePic).map((s) => [s.kind, s.open]),
    [
      ["md", undefined],
      ["mermaid", true],
      ["md", undefined],
      ["pictures", undefined],
    ],
  );
});

test("splitMarkdown puts pictures before a blockquote that starts with an empty quote line", () => {
  const segs = splitMarkdown("![p](a.png)\n\n>\n> quoted\n> more", (src) =>
    pictureFile(src, "/repo"),
  );
  assert.deepEqual(
    segs.map((s) => [s.kind, s.text]),
    [
      ["pictures", undefined],
      ["md", ">\n> quoted\n> more"],
    ],
  );
});

test("tokenizeLine colors common languages and preserves every character verbatim", () => {
  const js = '  export function greet(name = "Ada", n = 0x10) { return true; } // hi';
  const jsSpans = tokenizeLine(js, "js");
  assert.equal(jsSpans.map(([s]) => s).join(""), js);
  assert.deepEqual(
    jsSpans.filter(([, k]) => k !== null),
    [
      ["export", "keyword"],
      ["function", "keyword"],
      ["greet", "fn"],
      ['"Ada"', "string"],
      ["0x10", "number"],
      ["return", "keyword"],
      ["true", "const"],
      ["// hi", "comment"],
    ],
  );

  const py = "@route\ndef load(self, p: Path) -> None: # note";
  for (const line of py.split("\n")) {
    const spans = tokenizeLine(line, "py");
    assert.equal(spans.map(([s]) => s).join(""), line);
  }
  assert.equal(tokenizeLine("@route", "py")[0][1], "type");
  assert.deepEqual(
    tokenizeLine("def load(self, p: Path) -> None: # note", "py").filter(
      ([, k]) => k !== null,
    ),
    [
      ["def", "keyword"],
      ["load", "fn"],
      ["self", "const"],
      ["Path", "type"],
      ["None", "const"],
      ["# note", "comment"],
    ],
  );

  const rs = "#[derive(Clone)] pub fn first<'a>(x: &'a str) -> char { 'z' }";
  const rsSpans = tokenizeLine(rs, "rs");
  assert.equal(rsSpans.map(([s]) => s).join(""), rs);
  assert.deepEqual(
    rsSpans.filter(([, k]) => k !== null),
    [
      ["#[derive(Clone)]", "type"],
      ["pub", "keyword"],
      ["fn", "keyword"],
      ["first", "fn"],
      ["'a", "type"],
      ["'a", "type"],
      ["str", "type"],
      ["char", "type"],
      ["'z'", "string"],
    ],
  );

  assert.deepEqual(
    tokenizeLine('  "port": 8080,', "json").filter(([, k]) => k !== null),
    [
      ['"port"', "fn"],
      ["8080", "number"],
    ],
  );
  assert.deepEqual(
    tokenizeLine('export HOME="${USER_DIR}"', "sh").filter(([, k]) => k !== null),
    [
      ["export", "keyword"],
      ["HOME", "const"],
      ['"${USER_DIR}"', "string"],
    ],
  );
  assert.deepEqual(tokenizeLine("@font-face {", "css"), [["@font-face {", null]]);
  const css = "@media (max-width: 600px) { display: flex !important; }";
  const cssSpans = tokenizeLine(css, "scss");
  assert.equal(cssSpans.map(([s]) => s).join(""), css);
  assert.deepEqual(
    cssSpans.filter(([, k]) => k !== null),
    [
      ["@media", "keyword"],
      ["600", "number"],
      ["flex", "const"],
      ["!important", "keyword"],
    ],
  );
  const html = 'Text <img src="a.png" width="400"> more <!-- comment -->';
  const htmlSpans = tokenizeLine(html, "html");
  assert.equal(htmlSpans.map(([s]) => s).join(""), html);
  assert.deepEqual(
    htmlSpans.filter(([, k]) => k !== null),
    [
      ["<img", "keyword"],
      ["src", "type"],
      ['"a.png"', "string"],
      ["width", "type"],
      ['"400"', "string"],
      [">", "keyword"],
      ["<!-- comment -->", "comment"],
    ],
  );
  assert.deepEqual(tokenizeLine("plain text", "unknown"), [["plain text", null]]);
});

test("wrapMarkdown reflows prose paragraphs, blockquotes, and lists with hanging indents", () => {
  assert.equal(wrapMarkdown(""), "");
  assert.equal(
    wrapMarkdown("One two three\nfour five six seven eight nine.", 20),
    "One two three four\nfive six seven eight\nnine.",
  );
  assert.equal(
    wrapMarkdown("> Quoted prose that runs\n> across two lines and wraps.", 24),
    "> Quoted prose that runs\n> across two lines and\n> wraps.",
  );
  assert.equal(
    wrapMarkdown("> > Nested quote text that should wrap cleanly.", 24),
    "> > Nested quote text\n> > that should wrap\n> > cleanly.",
  );
  assert.equal(
    wrapMarkdown(
      "- First bullet item that is long enough to wrap.\n" +
        "* Second bullet item that wraps too.\n" +
        "+ Third bullet item.\n" +
        "10. Numbered item that wraps with four-space indent.",
      28,
    ),
    "- First bullet item that is\n" +
      "  long enough to wrap.\n" +
      "* Second bullet item that\n" +
      "  wraps too.\n" +
      "+ Third bullet item.\n" +
      "10. Numbered item that wraps\n" +
      "    with four-space indent.",
  );
  assert.equal(
    wrapMarkdown(
      "- First paragraph.\n\n  Second paragraph in the same list item wraps here.",
      28,
    ),
    "- First paragraph.\n\n  Second paragraph in the\n  same list item wraps here.",
  );
  assert.equal(
    wrapMarkdown("> - Quoted list item that wraps cleanly on continuation.", 26),
    "> - Quoted list item that\n>   wraps cleanly on\n>   continuation.",
  );
});

test("wrapMarkdown leaves code, tables, headings, rules, HTML, ref links, and hard breaks intact", () => {
  const doc = [
    "# A very long ATX heading that exceeds the wrap width and must stay on one line",
    "",
    "A very long Setext heading that exceeds the wrap width and must stay on one line",
    "===",
    "",
    "---",
    "***",
    "- - -",
    "",
    "```js",
    "const longLine = 'code inside backtick fence must never be wrapped even if long';",
    "```",
    "",
    "~~~txt",
    "code inside tilde fence must never be wrapped even if it is very long indeed",
    "~~~",
    "",
    "    indented code block line that is way longer than thirty columns and stays raw",
    "",
    "- Item with nested fence:",
    "",
    "  ```sh",
    "  echo 'nested fenced code block line that is way longer than thirty columns'",
    "  ```",
    "",
    "      indented code block inside list item that is way longer than thirty columns",
    "",
    "| Column One | Column Two | Column Three |",
    "| ---------- | ---------- | ------------ |",
    "| cell value | another very long cell value | third |",
    "",
    "Col A | Col B",
    "----- | -----",
    "very long borderless cell | another cell",
    "",
    '<div class="wide-container">HTML line that is longer than thirty columns</div>',
    "<!-- HTML comment line that is longer than thirty columns -->",
    "",
    "[ref-id]: https://example.com/a/very/long/reference/link/definition/path",
    "",
    "First line with two spaces  ",
    "Second line after spaces.",
    "",
    "First line with backslash\\",
    "Second line after slash.",
    "",
  ].join("\n");

  assert.equal(wrapMarkdown(doc, 30), doc);
});

test("wrapMarkdown avoids splitting inline links or overlong tokens and preserves EOL", () => {
  assert.equal(
    wrapMarkdown(
      "Read [the full documentation](https://example.com/very/long/path) right now.",
      30,
    ),
    "Read\n[the full documentation](https://example.com/very/long/path)\nright now.",
  );
  assert.equal(
    wrapMarkdown("See https://example.com/super/long/unbreakable/url here.", 25),
    "See\nhttps://example.com/super/long/unbreakable/url\nhere.",
  );
  assert.equal(
    wrapMarkdown("Use `a | b` in prose that is long enough to wrap cleanly.", 30),
    "Use `a | b` in prose that is\nlong enough to wrap cleanly.",
  );
  assert.equal(
    wrapMarkdown("Alpha beta\r\ngamma delta epsilon.\r\n", 18),
    "Alpha beta gamma\r\ndelta epsilon.\r\n",
  );
  assert.equal(
    wrapMarkdown("Alpha beta\ngamma delta", 40),
    "Alpha beta gamma delta",
  );
});

test("formatMarkdown pretty-prints GFM tables with alignments, padding, escaped pipes, and inline code", () => {
  const input = [
    "Intro paragraph that should wrap at thirty columns cleanly.",
    "",
    "| Name | Left | Center | Right |",
    "| --- | :--- | :---: | ---: |",
    "| a | `x|y` | ok | 5 |",
    "| banana | foo \\| bar | middle | 12345 |",
    "| short | only two |",
    "",
  ].join("\n");

  const expected = [
    "Intro paragraph that should",
    "wrap at thirty columns",
    "cleanly.",
    "",
    "| Name   | Left       | Center | Right |",
    "| ------ | :--------- | :----: | ----: |",
    "| a      | `x|y`      |   ok   |     5 |",
    "| banana | foo \\| bar | middle | 12345 |",
    "| short  | only two   |        |       |",
    "",
  ].join("\n");

  assert.equal(formatMarkdown(input, 30), expected);
});

test("formatMarkdown handles borderless tables, quoted tables, code fences, and non-table pipes", () => {
  const input = [
    "a | b | c",
    "---| :---: |---:",
    "1 | 22 | 3",
    "",
    "> | k | v |",
    "> |---|---|",
    "> | alpha | 1 |",
    "",
    "```md",
    "| raw | table |",
    "|---|---|",
    "| keep | untouched |",
    "```",
    "",
    "| stray | pipe | without | delimiter |",
  ].join("\n");

  const expected = [
    "| a   |   b   |    c |",
    "| --- | :---: | ---: |",
    "| 1   |  22   |    3 |",
    "",
    "> | k     | v   |",
    "> | ----- | --- |",
    "> | alpha | 1   |",
    "",
    "```md",
    "| raw | table |",
    "|---|---|",
    "| keep | untouched |",
    "```",
    "",
    "| stray | pipe | without | delimiter |",
  ].join("\n");

  assert.equal(formatMarkdown(input, 88), expected);
});

test("machineOf reads the machine from a tab id", () => {
  assert.equal(machineOf("tb1"), null);
  assert.equal(machineOf("devbox/tb1"), "devbox");
});

test("sameSize tolerates the precision that Herdr stores", () => {
  assert.ok(sameSize({ weight: 1.0589168 }, { weight: 1.0589168071746826 }));
  assert.ok(!sameSize({ weight: 1 }, { weight: 1.1 }));
  assert.ok(sameSize({ px: 320 }, { px: 320.2 }));
  assert.ok(!sameSize({ px: 320 }, { px: 400 }));
  assert.ok(!sameSize({ px: 320 }, { weight: 1 }));
  assert.ok(!sameSize({ px: 320 }, undefined));
});

test("samePanel compares the mode, and the sizes of an open panel", () => {
  const sizes = { main: { weight: 1.2 }, panel: { weight: 0.8 } };
  const wide = { main: { weight: 0.8 }, panel: { weight: 1.2 } };

  assert.ok(samePanel({ mode: "files", sizes }, { mode: "files", sizes }));
  assert.ok(!samePanel({ mode: "files", sizes }, { mode: "changes", sizes }));
  assert.ok(!samePanel({ mode: "files", sizes }, { mode: "files", sizes: wide }));
  // A tab that saved no sizes accepts the size that the panel has.
  assert.ok(samePanel({ mode: "files" }, { mode: "files", sizes: wide }));
  // A closed panel has no size to compare.
  assert.ok(samePanel({ mode: null, sizes }, { mode: null, sizes: wide }));
  assert.ok(samePanel({}, { mode: null, sizes }));
  assert.ok(!samePanel({ mode: null }, { mode: "files", sizes }));
});

test("editorLanguage maps extensions, special filenames, and edge-case paths", () => {
  const cases = [
    ["ts alias", "src/app.ts", "js"],
    ["tsx alias uppercase", "src/App.TSX", "js"],
    ["mjs alias", "scripts/build.mjs", "js"],
    ["jsonc alias", ".vscode/settings.jsonc", "json"],
    ["toml alias", "Cargo.toml", "yaml"],
    ["scss alias", "styles/theme.scss", "css"],
    ["zsh alias", "scripts/env.zsh", "bash"],
    ["windows path", "scripts\\env.zsh", "bash"],
    ["native python", "app.py", "py"],
    ["native pyi", "types.pyi", "pyi"],
    ["native rust", "src/lib.rs", "rs"],
    ["native go", "cmd/main.go", "go"],
    ["native sh", "bin/run.sh", "sh"],
    ["makefile without extension", "dir.v1/Makefile", "makefile"],
    ["shell dotfile", "home/.zshrc", "bash"],
    ["unknown dotfile", ".gitignore", "txt"],
    ["extensionless file under dotted dir", "dir.v1/README", "txt"],
    ["trailing dot", "file.", "txt"],
    ["empty path", "", "txt"],
    ["prototype property filename", "constructor", "txt"],
    ["prototype property extension", "file.constructor", "constructor"],
  ];

  for (const [name, path, expected] of cases) {
    assert.equal(editorLanguage(path), expected, name);
  }
});

test("wrapSpans leaves short lines intact and wraps long colored spans at spaces", () => {
  const short = tokenizeLine("const x = 1;", "js");
  assert.deepEqual(wrapSpans(short, 40), [short]);
  assert.deepEqual(wrapSpans([], 40), [[]]);
  assert.deepEqual(wrapSpans(short, 0), [short]);

  const line = 'const message = "hello world from herdr";';
  const spans = tokenizeLine(line, "js");
  const wrapped = wrapSpans(spans, 22);
  assert.deepEqual(
    wrapped.map((row) => row.map(([text]) => text).join("")),
    ['const message = ', '"hello world from ', 'herdr";'],
  );
  assert.equal(
    wrapped.flat().map(([text]) => text).join(""),
    line,
  );
  // Color kind stays attached to every piece of a split string literal.
  assert.deepEqual(wrapped[1], [['"hello world from ', "string"]]);
  assert.deepEqual(wrapped[2], [
    ['herdr"', "string"],
    [";", null],
  ]);
});

test("wrapSpans handles hard breaks, indentation, surrogates, and empty spans", () => {
  const cases = [
    {
      name: "indented unbroken token",
      spans: [["        https://example.com/very/long/path", "comment"]],
      maxCols: 20,
      expected: [
        [["        https://exam", "comment"]],
        [["ple.com/very/long/pa", "comment"]],
        [["th", "comment"]],
      ],
    },
    {
      name: "mid-line surrogate pair",
      spans: [["abcd😀ef", "string"]],
      maxCols: 5,
      expected: [
        [["abcd", "string"]],
        [["😀ef", "string"]],
      ],
    },
    {
      name: "single-column surrogate pair",
      spans: [["😀a", "string"]],
      maxCols: 1,
      expected: [
        [["😀", "string"]],
        [["a", "string"]],
      ],
    },
    {
      name: "all-spaces line",
      spans: [[" ".repeat(10), null]],
      maxCols: 4,
      expected: [
        [["    ", null]],
        [["    ", null]],
        [["  ", null]],
      ],
    },
    {
      name: "empty span skipped during wrap",
      spans: [
        ["", null],
        ["hello world", "string"],
      ],
      maxCols: 6,
      expected: [
        [["hello ", "string"]],
        [["world", "string"]],
      ],
    },
  ];

  for (const { name, spans, maxCols, expected } of cases) {
    assert.deepEqual(wrapSpans(spans, maxCols), expected, name);
  }
});
