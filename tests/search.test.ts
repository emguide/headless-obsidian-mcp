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

// Two needle matches separated by 20 filler lines, so the second match's
// context_before (5 lines under context_lines=5) arrives as `context` JSON
// events strictly before ripgrep emits the second match's own `match` event.
// With max_matches_per_file: 1, those leaked context_before lines land on
// the LAST KEPT match's context_after if the cap isn't gated on buffer
// fullness alone (the bug this fixture reproduces).
function overlapContent(): string {
  const lines: string[] = ["# Overlap", "needle first"];
  for (let i = 0; i < 20; i++) {
    lines.push(`gap ${i}`);
  }
  lines.push("needle second");
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
    { path: "overlap.md", content: overlapContent() },
    {
      path: "exactly.md",
      content: ["# Exactly", "needle one", "filler", "needle two"].join("\n"),
    },
    { path: "ips.md", content: "# Hosts\nserver at 10.0.0.1 is up\n" },
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
  // 34 files match (30 n* + busy.md + spaced.md + overlap.md + exactly.md); 20 returned, 14 omitted.
  assert.equal(res.files_omitted, 14);
});

test("limit above default is honored with no upper clamp", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 100,
    max_matches_per_file: 0,
  });
  assert.equal(res.results.length, 34);
  assert.equal(res.files_omitted, 0);
  assert.equal(res.truncated, false);
});

test("limit 0 disables the file cap", async () => {
  const res = await searchNotes(fx.vaultPath, { pattern: "needle", limit: 0 });
  assert.equal(res.results.length, 34);
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

  // The last kept match's context_after must not exceed its own
  // context_lines-bounded window. Context is now assigned by line number
  // within the owning file, so a capped run's kept matches are byte-identical
  // to the same matches in an uncapped run — the cap changes how many matches
  // are returned, never the context attached to the ones that are.
  const lastKept = spacedCapped.matches[maxMatches - 1];
  assert.ok(
    lastKept.context_after.length <= contextLines,
    "context_after for the last kept match grew beyond its own context window " +
      "(bug: context lines from beyond the per-file cap kept appending to it)"
  );
  for (let i = 0; i < maxMatches; i++) {
    assert.deepEqual(
      spacedCapped.matches[i],
      spacedUncapped.matches[i],
      `capped match ${i} must match the uncapped run's same match exactly`
    );
  }

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

test("max_matches_per_file does not leak a dropped match's context_before into the last kept match (overlap)", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 1,
    context_lines: 5,
  });

  const overlap = res.results.find((r) => r.path === "overlap");
  assert.ok(overlap);
  assert.equal(overlap.matches.length, 1);

  const kept = overlap.matches[0];
  // Pre-fix this is 10: kept's own 5-line window PLUS the dropped second
  // match's 5-line context_before, leaked in because the context branch
  // only checked matchCapReachedForFile (set by a *match* event) instead of
  // the match buffer already being full.
  assert.ok(
    kept.context_after.length <= 5,
    `context_after leaked extra lines: length ${kept.context_after.length}, ${JSON.stringify(kept.context_after)}`
  );
  assert.ok(kept.context_before.length <= 5);

  assert.ok(res.matches_capped_in.includes("overlap"));
});

test("a file with exactly max_matches_per_file matches is not reported as capped", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "needle",
    limit: 0,
    max_matches_per_file: 2,
  });

  const exactly = res.results.find((r) => r.path === "exactly");
  assert.ok(exactly);
  assert.equal(exactly.matches.length, 2);
  assert.ok(!res.matches_capped_in.includes("exactly"));
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

// rg's default engine (Rust regex crate) is linear-time — catastrophic
// backtracking cannot occur — so ordinary patterns with several bounded
// quantifiers or groups must not be rejected as "too complex".
test("a pattern with multiple bounded quantifiers is accepted", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}",
  });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].path, "ips");
});

test("a pattern with five groups is accepted", async () => {
  const res = await searchNotes(fx.vaultPath, {
    pattern: "(n)(e)(e)(d)(le)",
    limit: 1,
  });
  assert.ok(res.results.length > 0);
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
