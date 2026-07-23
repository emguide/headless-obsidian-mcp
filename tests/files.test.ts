import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { listFiles } from "../src/tools/files.js";
import { makeVault, sampleNotes, Fixture, FixtureNote } from "./fixtures.js";

let fx: Fixture;
before(async () => {
  const notes: FixtureNote[] = [
    ...sampleNotes(),
    { path: "assets/logo.png", content: "PNGDATA" },
    { path: "assets/report.PDF", content: "PDFDATA" },
    { path: "sub/pic.PNG", content: "PNGDATA2" },
    { path: ".trash/junk.png", content: "IGNORED" }, // in an ignored dir
  ];
  fx = await makeVault(notes);
});
after(() => fx.cleanup());

test("lists only non-markdown files, skipping ignored dirs", async () => {
  const files = await listFiles(fx.vaultPath, {});
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["assets/logo.png", "assets/report.PDF", "sub/pic.PNG"]);
  assert.ok(!paths.some((p) => p.endsWith(".md")));
  assert.ok(!paths.some((p) => p.startsWith(".trash")));
});

test("path keeps the extension and reports fields", async () => {
  const files = await listFiles(fx.vaultPath, {});
  const png = files.find((f) => f.path === "assets/logo.png")!;
  assert.equal(png.extension, "png");
  assert.equal(typeof png.size, "number");
  assert.match(png.modified, /^\d{4}-\d{2}-\d{2}T/);
});

test("folder scopes to a subtree", async () => {
  const files = await listFiles(fx.vaultPath, { folder: "assets" });
  assert.deepEqual(files.map((f) => f.path).sort(), ["assets/logo.png", "assets/report.PDF"]);
});

test("extension filter is dot-optional and case-insensitive", async () => {
  const png = await listFiles(fx.vaultPath, { extension: ".PNG" });
  assert.deepEqual(png.map((f) => f.path).sort(), ["assets/logo.png", "sub/pic.PNG"]);
  const pdf = await listFiles(fx.vaultPath, { extension: "pdf" });
  assert.deepEqual(pdf.map((f) => f.path), ["assets/report.PDF"]);
});

test("limit caps the result", async () => {
  const files = await listFiles(fx.vaultPath, { limit: 1 });
  assert.equal(files.length, 1);
});
