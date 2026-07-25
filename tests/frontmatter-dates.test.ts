import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMatter, stringifyMatter } from "../src/tools/matter-safe.js";
import { isScalar, validateFrontmatterValue } from "../src/tools/note-document.js";
import { writeNote, addTag, setNoteFrontmatter, renameNoteProperty } from "../src/tools/write.js";

/**
 * YAML parses an unquoted `created: 2026-07-25` into a JS Date. Two bugs fell
 * out of that: isScalar rejected Date as a "nested object" (so ordinary
 * Obsidian frontmatter could not be written at all), and re-serialization
 * expanded it to a full ISO timestamp — silently rewriting a key the write
 * never addressed.
 */
async function vault(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "fm-dates-"));
}

test("Date is a valid scalar frontmatter value", () => {
  assert.equal(isScalar(new Date("2026-07-25T00:00:00Z")), true);
  assert.doesNotThrow(() => validateFrontmatterValue("created", new Date()));
  assert.doesNotThrow(() =>
    validateFrontmatterValue("dates", [new Date(), new Date()])
  );
  // Genuine nesting is still rejected.
  assert.throws(() => validateFrontmatterValue("k", { a: 1 }));
  assert.throws(() => validateFrontmatterValue("k", [{ a: 1 }]));
});

test("write_note accepts ordinary unquoted date frontmatter", async () => {
  const dir = await vault();
  await writeNote(dir, {
    path: "note",
    content: "---\ncreated: 2026-07-25\n---\nbody\n",
  });
  const raw = await readFile(join(dir, "note.md"), "utf-8");
  assert.match(raw, /created: 2026-07-25\n/);
});

test("a date-only key survives an unrelated frontmatter edit verbatim", async () => {
  const dir = await vault();
  await writeFile(
    join(dir, "n.md"),
    "---\ncreated: 2026-07-25\ntags: []\n---\nbody\n",
    "utf-8"
  );
  await addTag(dir, { path: "n", tags: ["work"] });

  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.match(raw, /created: 2026-07-25\n/, "date must not expand to an ISO timestamp");
  assert.doesNotMatch(raw, /00:00:00/);
  assert.match(raw, /- work/);
});

test("a date carrying a time keeps its full timestamp", async () => {
  const dir = await vault();
  await writeFile(
    join(dir, "n.md"),
    "---\nupdated: 2026-07-25T10:30:00.000Z\ntags: []\n---\nbody\n",
    "utf-8"
  );
  await addTag(dir, { path: "n", tags: ["work"] });

  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.match(raw, /updated: 2026-07-25T10:30:00\.000Z/);
});

test("dates survive set_frontmatter and rename_property too", async () => {
  const dir = await vault();
  await writeFile(
    join(dir, "n.md"),
    "---\ncreated: 2026-07-25\nauthor: me\n---\nbody\n",
    "utf-8"
  );
  await setNoteFrontmatter(dir, { path: "n", set: { status: "active" } });
  assert.match(await readFile(join(dir, "n.md"), "utf-8"), /created: 2026-07-25\n/);

  await renameNoteProperty(dir, { path: "n", from: "author", to: "authors" });
  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.match(raw, /created: 2026-07-25\n/);
  assert.match(raw, /authors: me/);
});

test("date-only values in an array round-trip", () => {
  const out = stringifyMatter("body\n", {
    dates: [new Date("2026-07-25T00:00:00Z"), new Date("2026-01-02T00:00:00Z")],
  });
  assert.match(out, /- 2026-07-25\n/);
  assert.match(out, /- 2026-01-02\n/);
  assert.doesNotMatch(out, /00:00:00/);
});

test("stringify/parse round-trips a date to the same instant", () => {
  const original = new Date("2026-07-25T00:00:00Z");
  const out = stringifyMatter("body\n", { created: original });
  const back = parseMatter(out).data.created as Date;
  assert.ok(back instanceof Date);
  assert.equal(back.toISOString(), original.toISOString());
});

test("string values that look like dates stay strings", () => {
  const out = stringifyMatter("body\n", { q: "2026-07-25" });
  const back = parseMatter(out).data.q;
  assert.equal(typeof back, "string");
  assert.equal(back, "2026-07-25");
});

test("non-date content is serialized unchanged", () => {
  const out = stringifyMatter("body\n", {
    title: "Alpha",
    n: 3,
    flag: true,
    tags: ["a", "b"],
    empty: null,
  });
  const back = parseMatter(out).data;
  assert.equal(back.title, "Alpha");
  assert.equal(back.n, 3);
  assert.equal(back.flag, true);
  assert.deepEqual(back.tags, ["a", "b"]);
  assert.equal(back.empty, null);
});

test("content containing the internal date token is not corrupted", () => {
  // Defensive: the placeholder must never eat real note text.
  const marker = "__obsidian_mcp_date_0__";
  const out = stringifyMatter(`body with ${marker} inline\n`, {
    created: new Date("2026-07-25T00:00:00Z"),
  });
  assert.ok(out.includes(`body with ${marker} inline`), "body text preserved");
});
