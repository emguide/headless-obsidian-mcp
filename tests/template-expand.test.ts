process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { expand } from "../src/tools/template-expand.js";

const NOW = new Date("2026-07-23T14:05:09Z");
const base = { title: "My Note", now: NOW };

test("{{title}} substitutes the title", () => {
  assert.equal(expand("# {{title}}", base), "# My Note");
});

test("bare {{date}} uses default YYYY-MM-DD", () => {
  assert.equal(expand("d: {{date}}", base), "d: 2026-07-23");
});

test("bare {{time}} uses default HH:mm", () => {
  assert.equal(
    expand("t: {{time}}", { ...base, now: new Date("2026-07-23T14:05:00Z") }),
    "t: 14:05"
  );
});

test("{{date:FORMAT}} honors an inline Moment format", () => {
  assert.equal(expand("{{date:YYYY/MM/DD}}", base), "2026/07/23");
});

test("advancedFormat token Do works", () => {
  assert.equal(expand("{{date:Do MMMM YYYY}}", base), "23rd July 2026");
});

test("[literal] escaping is preserved", () => {
  assert.equal(expand("{{date:[Week] YYYY}}", base), "Week 2026");
});

test("dateFormat/timeFormat options override the defaults", () => {
  assert.equal(
    expand("{{date}} {{time}}", {
      ...base,
      dateFormat: "DD.MM.YYYY",
      timeFormat: "HH.mm",
    }),
    "23.07.2026 14.05"
  );
});

test("unknown {{token}} passes through literally", () => {
  assert.equal(
    expand("{{tp.file.title}} {{cursor}}", base),
    "{{tp.file.title}} {{cursor}}"
  );
});

test("multiple placeholders in one template", () => {
  assert.equal(
    expand("# {{title}}\nCreated {{date}} at {{time}}", {
      title: "Log",
      now: new Date("2026-07-23T09:30:00Z"),
    }),
    "# Log\nCreated 2026-07-23 at 09:30"
  );
});
