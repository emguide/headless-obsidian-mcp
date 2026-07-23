import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NoteDocument,
  addTags,
  removeTags,
  setFrontmatter,
  addSection,
  appendToSection,
  replaceSection,
} from "../src/tools/note-document.js";

const SAMPLE = [
  "---",
  "title: Home",
  "tags: [moc, home]",
  "---",
  "# Home",
  "",
  "Intro.",
  "",
  "## Tasks",
  "",
  "- [ ] one",
  "",
  "## Notes",
  "",
  "some notes",
  "",
].join("\n");

test("body edits leave the frontmatter block byte-for-byte intact", () => {
  const doc = NoteDocument.parse(SAMPLE);
  appendToSection(doc, "Tasks", "- [ ] two");
  const out = doc.serialize();
  assert.match(out, /^---\ntitle: Home\ntags: \[moc, home\]\n---\n/);
});

test("appendToSection inserts before the next heading with single spacing", () => {
  const doc = NoteDocument.parse(SAMPLE);
  appendToSection(doc, "Tasks", "- [ ] two");
  assert.match(doc.serialize(), /- \[ \] one\n\n- \[ \] two\n\n## Notes/);
});

test("appendToSection can create a missing section", () => {
  const doc = NoteDocument.parse(SAMPLE);
  appendToSection(doc, "Later", "todo", true);
  assert.match(doc.serialize(), /## Later\ntodo\n?$/);
});

test("appendToSection throws on a missing section without create", () => {
  const doc = NoteDocument.parse(SAMPLE);
  assert.throws(() => appendToSection(doc, "Nope", "x"), /not found/);
});

test("replaceSection swaps only the section body", () => {
  const doc = NoteDocument.parse(SAMPLE);
  replaceSection(doc, "Notes", "brand new");
  const out = doc.serialize();
  assert.match(out, /## Notes\nbrand new\n?$/);
  assert.match(out, /- \[ \] one/); // Tasks section untouched
});

test("addSection appends at the end by default", () => {
  const doc = NoteDocument.parse(SAMPLE);
  addSection(doc, "Refs", "see also", 2);
  assert.match(doc.serialize(), /## Notes\n\nsome notes\n\n## Refs\nsee also\n?$/);
});

test("addSection can insert after a named section", () => {
  const doc = NoteDocument.parse(SAMPLE);
  addSection(doc, "Mid", "mid", 3, "Tasks");
  assert.match(doc.serialize(), /- \[ \] one\n\n### Mid\nmid\n\n## Notes/);
});

test("addSection rejects a duplicate heading at the same level", () => {
  const doc = NoteDocument.parse(SAMPLE);
  assert.throws(() => addSection(doc, "Tasks", "x", 2), /already exists/);
});

/* -------------------------------- fail-loud ambiguous section addressing -- */

// Two distinct "Log" sections under different parents.
const DUP = [
  "# Alpha",
  "alpha body",
  "## Log",
  "alpha log",
  "# Projects",
  "projects body",
  "## Log",
  "projects log",
].join("\n");

test("appendToSection errors on an ambiguous bare heading, listing candidates", () => {
  const doc = NoteDocument.parse(DUP);
  assert.throws(
    () => appendToSection(doc, "Log", "x"),
    /Ambiguous section "Log".*Alpha > Log.*Projects > Log/s
  );
});

test("appendToSection resolves a heading-path to the exact (non-first) section", () => {
  const doc = NoteDocument.parse(DUP);
  appendToSection(doc, "Projects > Log", "new line");
  const out = doc.serialize();
  // The new line lands under Projects > Log, not the first Alpha > Log.
  assert.match(out, /projects log\n\nnew line/);
  assert.doesNotMatch(out, /alpha log\n\nnew line/);
});

test("replaceSection errors on an ambiguous bare heading", () => {
  const doc = NoteDocument.parse(DUP);
  assert.throws(() => replaceSection(doc, "Log", "x"), /Ambiguous section "Log"/);
});

test("replaceSection resolves a heading-path to the exact section", () => {
  const doc = NoteDocument.parse(DUP);
  replaceSection(doc, "Alpha > Log", "replaced");
  const out = doc.serialize();
  assert.match(out, /## Log\nreplaced\n\n# Projects/);
  assert.match(out, /projects log/); // Projects > Log untouched
});

test("addSection after an ambiguous bare heading errors", () => {
  const doc = NoteDocument.parse(DUP);
  assert.throws(() => addSection(doc, "New", "x", 3, "Log"), /Ambiguous section "Log"/);
});

test("addSection after a heading-path inserts under the exact section", () => {
  const doc = NoteDocument.parse(DUP);
  addSection(doc, "Sub", "sub body", 3, "Projects > Log");
  const out = doc.serialize();
  assert.match(out, /projects log\n\n### Sub\nsub body/);
});

test("addSection still rejects a same-level duplicate even when the heading repeats", () => {
  // "Log" appears twice at level 2; adding a third level-2 "Log" must still be
  // rejected as a duplicate (existence check, not ambiguity error).
  const doc = NoteDocument.parse(DUP);
  assert.throws(() => addSection(doc, "Log", "x", 2), /already exists/);
});

test("unique bare heading still resolves for section writes", () => {
  const doc = NoteDocument.parse(DUP);
  // "Projects" is unique; its section runs to end of note. Append lands there.
  appendToSection(doc, "Projects", "added");
  const out = doc.serialize();
  assert.match(out, /projects log\n\nadded/);
});

test("headings inside fenced code blocks are ignored", () => {
  const raw = ["# Real", "", "```", "# not a heading", "```", "", "tail", ""].join("\n");
  const doc = NoteDocument.parse(raw);
  assert.throws(() => replaceSection(doc, "not a heading", "x"), /not found/);
});

test("addTags is idempotent and normalizes to a tags array", () => {
  const doc = NoteDocument.parse(SAMPLE);
  const result = addTags(doc, ["#project", "home"]); // home already present
  assert.deepEqual(result, ["moc", "home", "project"]);
  assert.match(doc.serialize(), /tags:\n  - moc\n  - home\n  - project\n/);
  assert.equal(addTags(doc, ["project"]), null); // no-op
});

test("removeTags drops the key when the list empties", () => {
  const doc = NoteDocument.parse("---\ntags: [solo]\n---\nbody\n");
  assert.deepEqual(removeTags(doc, ["solo"]), []);
  assert.doesNotMatch(doc.serialize(), /tags:/);
});

test("addTags creates frontmatter on a note that has none", () => {
  const doc = NoteDocument.parse("# Daily\n\nwork\n");
  addTags(doc, ["daily"]);
  assert.match(doc.serialize(), /^---\ntags:\n  - daily\n---\n# Daily/);
});

test("setFrontmatter sets and unsets fields, body preserved", () => {
  const doc = NoteDocument.parse(SAMPLE);
  const changed = setFrontmatter(doc, { status: "active" }, ["title"]);
  assert.equal(changed, true);
  const out = doc.serialize();
  assert.match(out, /status: active/);
  assert.doesNotMatch(out, /title: Home/);
  assert.match(out, /# Home\n\nIntro\./); // body intact
});

test("setFrontmatter reports no change when nothing matches", () => {
  const doc = NoteDocument.parse(SAMPLE);
  assert.equal(setFrontmatter(doc, undefined, ["absent"]), false);
});
