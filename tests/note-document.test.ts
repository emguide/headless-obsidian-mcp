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
