import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeNote,
  appendNote,
  addTag,
  setNoteFrontmatter,
  patchNote,
} from "../src/tools/write.js";
import { withVaultWriteLock } from "../src/tools/write-lock.js";
import { getFrontmatter } from "../src/tools/frontmatter.js";

/**
 * Git operations were serialized by withGitLock, but the read-modify-write span
 * itself was not: two concurrent calls could both read a note, both mutate
 * their own copy, and both write — the second silently discarding the first.
 */
async function vault(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "write-concurrency-"));
}

test("concurrent appends do not lose an update", async () => {
  const dir = await vault();
  await writeFile(join(dir, "log.md"), "start\n", "utf-8");

  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      appendNote(dir, { path: "log", content: `line-${i}` })
    )
  );

  const raw = await readFile(join(dir, "log.md"), "utf-8");
  for (let i = 0; i < 8; i++) {
    assert.match(raw, new RegExp(`line-${i}\\b`), `line-${i} was lost`);
  }
});

test("concurrent tag additions all survive", async () => {
  const dir = await vault();
  await writeFile(join(dir, "n.md"), "---\ntags: []\n---\nbody\n", "utf-8");

  await Promise.all(
    ["a", "b", "c", "d", "e", "f"].map((t) => addTag(dir, { path: "n", tags: [t] }))
  );

  const { frontmatter } = await getFrontmatter(dir, "n");
  assert.deepEqual((frontmatter.tags as string[]).sort(), ["a", "b", "c", "d", "e", "f"]);
});

test("concurrent frontmatter sets all survive", async () => {
  const dir = await vault();
  await writeFile(join(dir, "n.md"), "---\nkeep: yes\n---\nbody\n", "utf-8");

  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      setNoteFrontmatter(dir, { path: "n", set: { [`k${i}`]: i } })
    )
  );

  const { frontmatter } = await getFrontmatter(dir, "n");
  assert.equal(frontmatter.keep, "yes");
  for (let i = 0; i < 6; i++) {
    assert.equal(frontmatter[`k${i}`], i, `k${i} was lost`);
  }
});

test("overwrite:false still refuses under concurrency", async () => {
  const dir = await vault();

  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      writeNote(dir, { path: "same", content: `body ${i}\n` })
    )
  );

  const created = attempts.filter((a) => a.status === "fulfilled");
  const refused = attempts.filter((a) => a.status === "rejected");
  assert.equal(created.length, 1, "exactly one create may win");
  assert.equal(refused.length, 4, "the rest must be refused, not silently clobber");
  for (const r of refused) {
    assert.match((r as PromiseRejectedResult).reason.message, /already exists/);
  }
});

test("concurrent patches applied to the same note are all reflected", async () => {
  const dir = await vault();
  await writeFile(join(dir, "n.md"), "alpha bravo charlie\n", "utf-8");

  await Promise.all([
    patchNote(dir, { path: "n", find: "alpha", replace: "ALPHA" }),
    patchNote(dir, { path: "n", find: "bravo", replace: "BRAVO" }),
    patchNote(dir, { path: "n", find: "charlie", replace: "CHARLIE" }),
  ]);

  const raw = await readFile(join(dir, "n.md"), "utf-8");
  assert.equal(raw, "ALPHA BRAVO CHARLIE\n");
});

/* ------------------------------------------------------------- the lock -- */

test("the lock serializes overlapping sections", async () => {
  const dir = await vault();
  const order: string[] = [];
  const section = (name: string) =>
    withVaultWriteLock(dir, async () => {
      order.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${name}:exit`);
    });

  await Promise.all([section("a"), section("b"), section("c")]);

  // No section may enter before the previous one exits.
  for (let i = 0; i < order.length; i += 2) {
    assert.match(order[i], /:enter$/);
    assert.equal(order[i + 1], order[i].replace(":enter", ":exit"));
  }
});

test("the lock is reentrant within one async context", async () => {
  const dir = await vault();
  const result = await withVaultWriteLock(dir, async () =>
    // A public op taking the lock may call helpers that take it again.
    withVaultWriteLock(dir, async () => "inner ran")
  );
  assert.equal(result, "inner ran");
});

test("a throwing section releases the lock", async () => {
  const dir = await vault();
  await assert.rejects(() =>
    withVaultWriteLock(dir, async () => {
      throw new Error("boom");
    })
  );
  // The next waiter must still run.
  assert.equal(await withVaultWriteLock(dir, async () => "after"), "after");
});

test("different vaults do not block each other", async () => {
  const one = await vault();
  const two = await vault();
  let twoRan = false;

  await withVaultWriteLock(one, async () => {
    await withVaultWriteLock(two, async () => {
      twoRan = true;
    });
  });
  assert.equal(twoRan, true);
});
