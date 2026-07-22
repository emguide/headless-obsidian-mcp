import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { searchNotes } from "../src/tools/search.js";
import { makeVault, Fixture } from "./fixtures.js";

// 30 files each containing the word "needle" once.
function manyFiles(): { path: string; content: string }[] {
  return Array.from({ length: 30 }, (_, i) => ({
    path: `notes/n${i}.md`,
    content: `# Note ${i}\nThis note has a needle in it.\n`,
  }));
}

// Matches separated by filler lines so ripgrep emits real context blocks
// between them (unlike busy.md, where adjacent "needle" lines produce no
// context events at all).
function spacedContent(): string {
  const lines: string[] = ["# Spaced"];
  for (let i = 0; i < 8; i++) {
    lines.push(`needle line ${i}`);
    for (let j = 0; j < 6; j++) {
      lines.push(`filler ${i}-${j}`);
    }
  }
  return lines.join("\n");
}

let fx: Fixture;
before(async () => {
  fx = await makeVault([
    ...manyFiles(),
    {
      path: "busy.md",
      content: ["# Busy"].concat(Array.from({ length: 50 }, () => "needle line")).join("\n"),
    },
    { path: "empty-topic.md", content: "# Nothing here\nplain text only\n" },
    { path: "spaced.md", content: spacedContent() },
  ]);
});
after(async () => {
  await fx.cleanup();
});

test("defaults cap files at 20 and report truncation", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle" });
  assert.equal(res.results.length, 20);
  assert.equal(res.files_returned, 20);
  assert.equal(res.truncated, true);
  // 32 files match (30 n* + busy.md + spaced.md); 20 returned, 12 omitted.
  assert.equal(res.files_omitted, 12);
});

test("limit above default is honored with no upper clamp", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 100,
    max_matches_per_file: 0,
  });
  assert.equal(res.results.length, 32);
  assert.equal(res.files_omitted, 0);
  assert.equal(res.truncated, false);
});

test("limit 0 disables the file cap", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0 });
  assert.equal(res.results.length, 32);
  assert.equal(res.files_omitted, 0);
});

test("max_matches_per_file caps matches within a file", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 10,
  });
  const busy = res.results.find((r) => r.path === "busy");
  assert.ok(busy);
  assert.equal(busy.matches.length, 10);
  assert.ok(res.matches_capped_in.includes("busy"));
  assert.equal(res.truncated, true);
});

test("max_matches_per_file stops appending context lines once the cap is hit", async () => {
  const contextLines = 2;
  const maxMatches = 3;
  const capped = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    context_lines: contextLines,
    max_matches_per_file: maxMatches,
  });
  const uncapped = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    context_lines: contextLines,
    max_matches_per_file: 0,
  });

  const spacedCapped = capped.results.find((r) => r.path === "spaced");
  const spacedUncapped = uncapped.results.find((r) => r.path === "spaced");
  assert.ok(spacedCapped);
  assert.ok(spacedUncapped);
  assert.equal(spacedCapped.matches.length, maxMatches);
  assert.ok(capped.matches_capped_in.includes("spaced"));

  // The last kept match's context must match exactly what the SAME match
  // gets in an uncapped run of the same file. If the per-file cap fails to
  // gate context events (the bug), skipped matches beyond the cap keep
  // feeding filler lines into this match's context_after, so it would grow
  // larger here than in the uncapped run instead of staying identical.
  const lastKept = spacedCapped.matches[maxMatches - 1];
  const sameMatchUncapped = spacedUncapped.matches[maxMatches - 1];
  assert.deepEqual(
    lastKept.context_after,
    sameMatchUncapped.context_after,
    "context_after for the last kept match grew beyond its own context window " +
      "(bug: context lines from beyond the per-file cap kept appending to it)"
  );
  assert.deepEqual(lastKept.context_before, sameMatchUncapped.context_before);

  // None of the context text belonging exclusively to skipped (beyond-cap)
  // matches should appear anywhere in the capped file's kept matches.
  for (let i = maxMatches; i < spacedUncapped.matches.length; i++) {
    const skippedMatchContent = spacedUncapped.matches[i].content;
    for (const match of spacedCapped.matches) {
      assert.ok(
        !match.context_after.includes(skippedMatchContent) &&
          !match.context_before.includes(skippedMatchContent),
        `content from skipped match (beyond cap) leaked into kept match context: ${JSON.stringify(skippedMatchContent)}`
      );
    }
  }
});

test("max_matches_per_file 0 returns all matches for a file", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 0,
  });
  const busy = res.results.find((r) => r.path === "busy");
  assert.ok(busy);
  assert.equal(busy.matches.length, 50);
  assert.deepEqual(res.matches_capped_in, []);
});

test("no matches returns empty results with empty flags", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "zzz-no-such-token" });
  assert.deepEqual(res.results, []);
  assert.equal(res.truncated, false);
  assert.equal(res.files_returned, 0);
  assert.equal(res.files_omitted, 0);
  assert.deepEqual(res.matches_capped_in, []);
});

test("negative limit throws", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", limit: -1 }),
    /limit must be a non-negative integer/
  );
});

test("non-integer max_matches_per_file throws", async () => {
  await assert.rejects(
    () => searchNotes(fx.vaultPath, { pattern: "needle", max_matches_per_file: 2.5 }),
    /max_matches_per_file must be a non-negative integer/
  );
});
