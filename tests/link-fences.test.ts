import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractLinkTargets, extractLinkRefs, rewriteWikilinks } from "../src/tools/vault.js";
import { getLinks } from "../src/tools/links.js";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { moveNote } from "../src/tools/write.js";

/**
 * Wikilink extraction ran the regex over the whole body with no fence
 * awareness, unlike parseHeadings/parseTasks in the same module. A [[link]]
 * inside a code block — a note documenting Obsidian syntax, say — became a real
 * graph edge: phantom backlinks, and a permanent false unresolved_links finding
 * that no edit outside the fence could clear. Obsidian ignores them.
 */
const FENCED = [
  "# Doc",
  "",
  "Real link to [[alpha]].",
  "",
  "```",
  "[[not-a-real-note]]",
  "```",
  "",
  "Another real [[beta]].",
  "",
].join("\n");

test("links inside a fenced block are not extracted", () => {
  const targets = extractLinkTargets(FENCED);
  assert.deepEqual(targets, ["alpha", "beta"]);
  assert.ok(!targets.includes("not-a-real-note"));
});

test("extractLinkRefs skips fenced links too", () => {
  const refs = extractLinkRefs(FENCED).map((r) => r.target);
  assert.deepEqual(refs, ["alpha", "beta"]);
});

test("tilde fences and language tags are handled", () => {
  const body = [
    "[[real]]",
    "~~~md",
    "[[fenced-tilde]]",
    "~~~",
    "```javascript",
    "[[fenced-lang]]",
    "```",
    "",
  ].join("\n");
  assert.deepEqual(extractLinkTargets(body), ["real"]);
});

test("an unterminated fence swallows the rest of the note", () => {
  const body = ["[[before]]", "```", "[[after]]", "[[also-after]]"].join("\n");
  assert.deepEqual(extractLinkTargets(body), ["before"]);
});

test("a fence marker inside a different fence type does not close it", () => {
  const body = ["```", "~~~", "[[still-fenced]]", "```", "[[free]]", ""].join("\n");
  assert.deepEqual(extractLinkTargets(body), ["free"]);
});

test("rewriteWikilinks leaves fenced links untouched", () => {
  const { content, changed } = rewriteWikilinks(FENCED, (t) =>
    t === "alpha" || t === "not-a-real-note" ? "renamed" : null
  );
  assert.equal(changed, 1, "only the real link is rewritten");
  assert.match(content, /Real link to \[\[renamed\]\]/);
  assert.match(content, /\[\[not-a-real-note\]\]/, "code sample must be preserved verbatim");
});

test("get_links ignores fenced links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "link-fence-"));
  await writeFile(join(dir, "doc.md"), FENCED, "utf-8");
  await writeFile(join(dir, "alpha.md"), "a\n", "utf-8");
  await writeFile(join(dir, "beta.md"), "b\n", "utf-8");

  const links = await getLinks(dir, "doc");
  assert.deepEqual(links.outbound_links.map((l) => l.path).sort(), ["alpha", "beta"]);
  assert.deepEqual(links.unresolved_links, [], "no phantom unresolved link");
});

test("list_vault_issues reports no unresolved link for a fenced sample", async () => {
  const dir = await mkdtemp(join(tmpdir(), "link-fence-issues-"));
  await writeFile(join(dir, "doc.md"), FENCED, "utf-8");
  await writeFile(join(dir, "alpha.md"), "a\n", "utf-8");
  await writeFile(join(dir, "beta.md"), "b\n", "utf-8");

  const issues = await listVaultIssues(dir, { kind: "unresolved_links", limit: 0 });
  assert.deepEqual(issues.results, []);
});

test("move_note does not rewrite a link inside a code sample", async () => {
  const dir = await mkdtemp(join(tmpdir(), "link-fence-move-"));
  await writeFile(join(dir, "alpha.md"), "a\n", "utf-8");
  await writeFile(
    join(dir, "doc.md"),
    "Real [[alpha]]\n\n```\n[[alpha]]\n```\n",
    "utf-8"
  );

  await moveNote(dir, { from: "alpha", to: "moved" });

  const doc = await readFile(join(dir, "doc.md"), "utf-8");
  assert.match(doc, /Real \[\[moved\]\]/, "the real link is updated");
  assert.match(doc, /```\n\[\[alpha\]\]\n```/, "the code sample is left alone");
});
