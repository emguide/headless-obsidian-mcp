import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NoteDocument,
  addPropertyValues,
  removePropertyValues,
  renameProperty,
} from "../src/tools/note-document.js";

function parse(fm: string): NoteDocument {
  return NoteDocument.parse(`---\n${fm}\n---\nbody\n`);
}

test("addPropertyValues creates a new array key", () => {
  const doc = parse("title: X");
  const out = addPropertyValues(doc, "aliases", ["a", "b"]);
  assert.deepEqual(out, ["a", "b"]);
  assert.deepEqual(doc.data.aliases, ["a", "b"]);
});

test("addPropertyValues appends without duplicating", () => {
  const doc = parse("aliases: [a, b]");
  const out = addPropertyValues(doc, "aliases", ["b", "c"]);
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("addPropertyValues returns null when nothing new is added", () => {
  const doc = parse("aliases: [a, b]");
  assert.equal(addPropertyValues(doc, "aliases", ["a"]), null);
});

test("addPropertyValues promotes a scalar key to an array", () => {
  const doc = parse("alias: foo");
  const out = addPropertyValues(doc, "alias", ["bar"]);
  assert.deepEqual(out, ["foo", "bar"]);
});

test("addPropertyValues rejects a markdown value", () => {
  const doc = parse("title: X");
  assert.throws(() => addPropertyValues(doc, "aliases", ["[[bad]]"]), /markdown/i);
});

test("removePropertyValues removes members and keeps the rest", () => {
  const doc = parse("aliases: [a, b, c]");
  const out = removePropertyValues(doc, "aliases", ["b"]);
  assert.deepEqual(out, ["a", "c"]);
});

test("removePropertyValues drops the key when emptied", () => {
  const doc = parse("aliases: [a]");
  const out = removePropertyValues(doc, "aliases", ["a"]);
  assert.deepEqual(out, []);
  assert.equal("aliases" in doc.data, false);
});

test("removePropertyValues returns null when nothing matched", () => {
  const doc = parse("aliases: [a]");
  assert.equal(removePropertyValues(doc, "aliases", ["z"]), null);
});

test("renameProperty renames a key preserving its value", () => {
  const doc = parse("author: jane");
  assert.equal(renameProperty(doc, "author", "authors"), true);
  assert.equal(doc.data.author, undefined);
  assert.equal(doc.data.authors, "jane");
});

test("renameProperty throws when the source key is absent", () => {
  const doc = parse("title: X");
  assert.throws(() => renameProperty(doc, "nope", "x"), /not found/i);
});

test("renameProperty throws when the destination key already exists", () => {
  const doc = parse("a: 1\nb: 2");
  assert.throws(() => renameProperty(doc, "a", "b"), /already exists/i);
});
