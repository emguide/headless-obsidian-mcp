import { test } from "node:test";
import assert from "node:assert/strict";
import { getLinks } from "../src/tools/links.js";
import { deleteNote } from "../src/tools/write.js";
import { listVaultIssues } from "../src/tools/vault-issues.js";
import { scanLinkLines } from "../src/tools/link-context.js";
import { makeVault, FixtureNote } from "./fixtures.js";
import type {
  LinksResultWithContext,
  UnresolvedLinkGroupWithContext,
  BrokenAnchorGroupWithContext,
} from "../src/types.js";

/**
 * A small vault exercising every context case: a frontmatter block (so line
 * numbers must be body-relative), alias and anchor link forms, a plain text
 * mention that must NOT count, an unresolved link, a broken anchor, and a
 * self-anchor.
 */
function contextNotes(): FixtureNote[] {
  return [
    {
      path: "hub.md",
      content: [
        "---",
        "title: Hub",
        "---",
        "# Hub", //                                                body line 1
        "Intro line.", //                                          body line 2
        "See [[target]] here.", //                                 body line 3
        "Also [[target|the target]] and [[target#Section]].", //   body line 4
        "Plain mention of target without a link.", //              body line 5
        "[[missing]] broken link here.", //                        body line 6
      ].join("\n"),
    },
    {
      path: "target.md",
      content: [
        "# Target", //                body line 1
        "## Section", //              body line 2
        "Links back to [[hub]].", //  body line 3
      ].join("\n"),
    },
    {
      path: "other.md",
      content: [
        "# Other", //                              body line 1
        "[[target]] twice: [[target]] again.", //  body line 2
        "And a broken [[target#Nope]] anchor.", // body line 3
      ].join("\n"),
    },
    {
      path: "selfref.md",
      content: [
        "# Self", //           body line 1
        "[[#Nope]] link.", //  body line 2
      ].join("\n"),
    },
  ];
}

test("get_links without include_context keeps the bare shapes", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = await getLinks(fx.vaultPath, "hub");
    assert.deepEqual(res.unresolved_links, ["missing"]);
    assert.deepEqual(res.backlinks, ["target"]);
    assert.ok(!("context" in res.outbound_links[0]));
  } finally {
    await fx.cleanup();
  }
});

test("get_links include_context decorates outbound links with body-relative lines", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = (await getLinks(fx.vaultPath, "hub", {
      include_context: true,
    })) as LinksResultWithContext;
    assert.equal(res.outbound_links.length, 1);
    const out = res.outbound_links[0];
    assert.equal(out.path, "target");
    // Lines 3 and 4 link (plain, alias, and anchor forms); the bare text
    // mention on line 5 must not appear.
    assert.deepEqual(out.context, [
      { line: 3, text: "See [[target]] here." },
      { line: 4, text: "Also [[target|the target]] and [[target#Section]]." },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("get_links include_context decorates unresolved links", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = (await getLinks(fx.vaultPath, "hub", {
      include_context: true,
    })) as LinksResultWithContext;
    assert.deepEqual(res.unresolved_links, [
      {
        target: "missing",
        context: [{ line: 6, text: "[[missing]] broken link here." }],
      },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("get_links include_context decorates backlinks with the linking lines", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = (await getLinks(fx.vaultPath, "target", {
      include_context: true,
    })) as LinksResultWithContext;
    assert.deepEqual(res.backlinks, [
      {
        path: "hub",
        context: [
          { line: 3, text: "See [[target]] here." },
          { line: 4, text: "Also [[target|the target]] and [[target#Section]]." },
        ],
      },
      {
        path: "other",
        context: [
          { line: 2, text: "[[target]] twice: [[target]] again." },
          { line: 3, text: "And a broken [[target#Nope]] anchor." },
        ],
      },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("delete_note include_context reports what each dangled backlink says", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = await deleteNote(fx.vaultPath, "target", {
      include_context: true,
    });
    assert.equal(res.deleted, true);
    assert.deepEqual(res.dangled_backlinks, [
      {
        path: "hub",
        context: [
          { line: 3, text: "See [[target]] here." },
          { line: 4, text: "Also [[target|the target]] and [[target#Section]]." },
        ],
      },
      {
        path: "other",
        context: [
          { line: 2, text: "[[target]] twice: [[target]] again." },
          { line: 3, text: "And a broken [[target#Nope]] anchor." },
        ],
      },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("delete_note without the flag keeps the plain string shape", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = await deleteNote(fx.vaultPath, "target");
    assert.deepEqual(res.dangled_backlinks, ["hub", "other"]);
  } finally {
    await fx.cleanup();
  }
});

test("list_vault_issues unresolved_links include_context decorates targets", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = await listVaultIssues(fx.vaultPath, {
      kind: "unresolved_links",
      include_context: true,
    });
    const groups = res.results as UnresolvedLinkGroupWithContext[];
    assert.deepEqual(groups, [
      {
        source: "hub",
        targets: [
          {
            target: "missing",
            context: [{ line: 6, text: "[[missing]] broken link here." }],
          },
        ],
      },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("list_vault_issues broken_anchors include_context decorates targets, including self-anchors", async () => {
  const fx = await makeVault(contextNotes());
  try {
    const res = await listVaultIssues(fx.vaultPath, {
      kind: "broken_anchors",
      include_context: true,
    });
    const groups = res.results as BrokenAnchorGroupWithContext[];
    assert.deepEqual(groups, [
      {
        source: "other",
        targets: [
          {
            target: "target",
            anchor: "Nope",
            context: [{ line: 3, text: "And a broken [[target#Nope]] anchor." }],
          },
        ],
      },
      {
        source: "selfref",
        targets: [
          {
            target: "",
            anchor: "Nope",
            context: [{ line: 2, text: "[[#Nope]] link." }],
          },
        ],
      },
    ]);
  } finally {
    await fx.cleanup();
  }
});

test("list_vault_issues orphans rejects include_context loudly", async () => {
  const fx = await makeVault(contextNotes());
  try {
    await assert.rejects(
      () =>
        listVaultIssues(fx.vaultPath, { kind: "orphans", include_context: true }),
      /include_context/
    );
  } finally {
    await fx.cleanup();
  }
});

test("scanLinkLines degrades to no lines when the file is unreadable", async () => {
  const lines = await scanLinkLines("/nonexistent/nowhere.md");
  assert.deepEqual(lines, []);
});
