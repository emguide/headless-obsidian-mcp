import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { clearIndexCache } from "../src/tools/vault-index.js";

export interface FixtureNote {
  /** Relative path within the vault, including the .md extension. */
  path: string;
  /** File body (frontmatter + markdown). */
  content: string;
  /** Optional mtime to stamp on the file, for recency tests. */
  mtime?: Date;
}

export interface Fixture {
  vaultPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a throwaway vault on disk populated with the given notes, each in its
 * own unique temp directory so the shared index cache never collides between
 * tests. The index cache is cleared so the fixture starts from a clean slate.
 */
export async function makeVault(notes: FixtureNote[]): Promise<Fixture> {
  clearIndexCache();
  const vaultPath = await mkdtemp(join(tmpdir(), "notes-mcp-test-"));

  for (const note of notes) {
    const full = join(vaultPath, note.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, note.content, "utf-8");
    if (note.mtime) {
      await utimes(full, note.mtime, note.mtime);
    }
  }

  return {
    vaultPath,
    cleanup: () => rm(vaultPath, { recursive: true, force: true }),
  };
}

/** The default fixture used by most tests: a small interlinked vault. */
export function sampleNotes(): FixtureNote[] {
  return [
    {
      path: "index.md",
      content: [
        "---",
        "title: Home",
        "tags: [moc, home]",
        "---",
        "# Home",
        "Links to [[projects/alpha]] and [[Beta Note|beta]] and [[missing-note]].",
      ].join("\n"),
      mtime: new Date("2026-07-10T10:00:00Z"),
    },
    {
      path: "projects/alpha.md",
      content: [
        "---",
        "title: Alpha Project",
        "status: active",
        "updated: 2026-07-20",
        "tags:",
        "  - project",
        "  - project/active",
        "---",
        "# Alpha",
        "Some #productivity notes. See [[index]].",
      ].join("\n"),
      mtime: new Date("2026-07-21T10:00:00Z"),
    },
    {
      path: "Beta Note.md",
      content: [
        "---",
        "status: archived",
        "---",
        "# Beta",
        "References [[projects/alpha]]. Tagged #productivity #archive.",
      ].join("\n"),
      mtime: new Date("2026-07-05T10:00:00Z"),
    },
    {
      path: "daily/2026-07-22.md",
      content: ["# Daily", "Working on [[projects/alpha]] today. #daily"].join(
        "\n"
      ),
      mtime: new Date("2026-07-22T10:00:00Z"),
    },
  ];
}
