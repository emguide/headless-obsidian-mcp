import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dayjs, formatMoment } from "../src/tools/date-format.js";
import { expand } from "../src/tools/template-expand.js";
import { resolveDailyNote } from "../src/tools/daily-notes.js";

/**
 * Template placeholders and daily-note filename formats both promise
 * Moment.js-compatible tokens, because that is what Obsidian uses. dayjs
 * without the week plugins threw "t.weekYear is not a function" on a common
 * weekly-note format, and rendered DDD by concatenating three D's ("2525")
 * instead of the day of year ("206").
 */
const D = dayjs("2026-07-25"); // day of year 206, ISO week 30

test("week tokens render instead of throwing", () => {
  assert.equal(formatMoment(D, "gggg-[W]ww"), "2026-W30");
  assert.equal(formatMoment(D, "ww"), "30");
  assert.equal(formatMoment(D, "WW"), "30");
  assert.equal(formatMoment(D, "gggg"), "2026");
  assert.equal(formatMoment(D, "GGGG"), "2026");
});

test("day-of-year tokens match Moment", () => {
  assert.equal(formatMoment(D, "DDD"), "206");
  assert.equal(formatMoment(D, "DDDD"), "206");
  // Early in the year DDDD zero-pads to three digits, DDD does not.
  const jan5 = dayjs("2026-01-05");
  assert.equal(formatMoment(jan5, "DDD"), "5");
  assert.equal(formatMoment(jan5, "DDDD"), "005");
});

test("DD and D still mean day of month", () => {
  assert.equal(formatMoment(D, "DD"), "25");
  assert.equal(formatMoment(D, "D"), "25");
  assert.equal(formatMoment(D, "YYYY-MM-DD"), "2026-07-25");
});

test("bracket escapes are preserved verbatim", () => {
  assert.equal(formatMoment(D, "[W]ww"), "W30");
  assert.equal(formatMoment(D, "[Day] DDD [of] YYYY"), "Day 206 of 2026");
  // A literal DDD inside brackets must not be substituted.
  assert.equal(formatMoment(D, "[DDD]"), "DDD");
  // Unterminated escape passes through rather than throwing.
  assert.doesNotThrow(() => formatMoment(D, "[unterminated"));
});

test("previously working tokens are unchanged", () => {
  assert.equal(formatMoment(D, "Do MMMM YYYY"), "25th July 2026");
  assert.equal(formatMoment(D, "Q"), "3");
  assert.equal(formatMoment(D, "HH:mm"), "00:00");
});

test("template placeholders use the same engine", () => {
  const now = new Date("2026-07-25T14:05:00Z");
  assert.equal(expand("{{date:gggg-[W]ww}}", { title: "N", now }), "2026-W30");
  assert.equal(expand("{{date:DDD}}", { title: "N", now }), "206");
  // Unknown tokens still pass through untouched.
  assert.equal(expand("{{tp.file.title}}", { title: "N", now }), "{{tp.file.title}}");
  assert.equal(expand("{{title}}", { title: "N", now }), "N");
});

test("a bare {{date}} honours a configured week format", () => {
  const now = new Date("2026-07-25T14:05:00Z");
  assert.equal(
    expand("{{date}}", { title: "N", now, dateFormat: "gggg-[W]ww" }),
    "2026-W30"
  );
});

test("resolve_daily_note handles a weekly-note filename format", async () => {
  const vault = await mkdtemp(join(tmpdir(), "daily-week-"));
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(
    join(vault, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "journal", format: "gggg-[W]ww" }),
    "utf-8"
  );

  const result = await resolveDailyNote(vault, { date: "2026-07-25" });
  assert.equal(result.path, "journal/2026-W30");
  assert.equal(result.date, "2026-07-25");
});

test("resolve_daily_note handles a day-of-year filename format", async () => {
  const vault = await mkdtemp(join(tmpdir(), "daily-doy-"));
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(
    join(vault, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "", format: "YYYY-DDDD" }),
    "utf-8"
  );

  const result = await resolveDailyNote(vault, { date: "2026-07-25" });
  assert.equal(result.path, "2026-206");
});
