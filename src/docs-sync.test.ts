// Grundsatz Nr. 6 (Rudelnacht 11 Nov 2026, Tyto + Kiro + Nyx): one source per
// instruction; where it is copied anyway, a measurement checks both are the same,
// and a copy for another situation names its difference.
// Here: the init command in EXCHANGE-RUNBOOK.md Phase 1 (source) and in
// LOCAL-SHARE-REINIT.md Step 2 (copy for a re-init) must be equal except --force.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Built as CommonJS: __dirname is dist/, the repo root one up.
const root = join(__dirname, "..");
const doc = (name: string) => readFileSync(join(root, "docs", name), "utf8");

/** First ```bash block after the heading that starts with `heading`. */
function firstBashBlockAfter(md: string, heading: string): string {
  const at = md.indexOf("\n" + heading);
  assert.ok(at >= 0, `heading not found: ${heading}`);
  const m = /```bash\n([\s\S]*?)```/.exec(md.slice(at));
  assert.ok(m, `no bash block after: ${heading}`);
  return m![1];
}

/** Command words + flags (with their placeholder values), line continuations joined. */
function commandTokens(block: string): string[] {
  return block.replace(/\\\n/g, " ").split(/\s+/).filter(Boolean);
}

/** Flags of a command as a map flag → value ("" for bare flags).
 *  A flag given twice is collected in `dupes` instead of silently
 *  overwriting the first value (Tyto, review #62). */
function flagMap(tokens: string[]): {
  m: Map<string, string>;
  dupes: string[];
} {
  const m = new Map<string, string>();
  const dupes: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) continue;
    if (m.has(t)) dupes.push(t);
    const next = tokens[i + 1];
    m.set(t, next && !next.startsWith("--") ? next : "");
  }
  return { m, dupes };
}

/** Differences between source and copy, as readable strings. */
function diffCommands(source: string[], copy: string[]): string[] {
  const out: string[] = [];
  const head = (t: string[]) =>
    t
      .slice(
        0,
        t.findIndex((x) => x.startsWith("--")),
      )
      .join(" ");
  if (head(source) !== head(copy))
    out.push(`command: "${head(source)}" vs "${head(copy)}"`);
  const fa = flagMap(source),
    fb = flagMap(copy);
  for (const k of fa.dupes) out.push(`duplicate in source: ${k}`);
  for (const k of fb.dupes) out.push(`duplicate in copy: ${k}`);
  const a = fa.m,
    b = fb.m;
  for (const [k, v] of a) {
    if (!b.has(k)) out.push(`missing in copy: ${k}`);
    else if (b.get(k) !== v) out.push(`value of ${k}: "${v}" vs "${b.get(k)}"`);
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`only in copy: ${k}`);
  return out;
}

const runbook = commandTokens(
  firstBashBlockAfter(doc("EXCHANGE-RUNBOOK.md"), "## Phase 1"),
);
const reinit = commandTokens(
  firstBashBlockAfter(doc("LOCAL-SHARE-REINIT.md"), "## Step 2"),
);

test("re-init Step 2 = Runbook Phase 1 init, except the named --force", () => {
  assert.deepEqual(diffCommands(runbook, reinit), ["only in copy: --force"]);
});

test("the difference is named in the text next to the copy", () => {
  const md = doc("LOCAL-SHARE-REINIT.md");
  const step2 = md.slice(md.indexOf("\n## Step 2"), md.indexOf("\n## Step 3"));
  assert.match(step2, /\*\*`--force`\*\* is required here/);
  assert.match(step2, /docs-sync\.test\.ts/);
});

test("the comparison itself can turn red (each kind of drift is reported)", () => {
  const base = commandTokens(
    "node dist/cli.js cross-backup init \\\n  --agent <name> --shares-out <d>",
  );
  assert.deepEqual(diffCommands(base, base), []);
  assert.deepEqual(
    diffCommands(
      base,
      commandTokens("node dist/cli.js cross-backup init --agent <name>"),
    ),
    ["missing in copy: --shares-out"],
  );
  assert.deepEqual(
    diffCommands(
      base,
      commandTokens(
        "node dist/cli.js cross-backup init --agent <x> --shares-out <d>",
      ),
    ),
    ['value of --agent: "<name>" vs "<x>"'],
  );
  assert.deepEqual(
    diffCommands(
      base,
      commandTokens(
        "node dist/cli.js cross-backup rotate --agent <name> --shares-out <d>",
      ),
    ),
    [
      'command: "node dist/cli.js cross-backup init" vs "node dist/cli.js cross-backup rotate"',
    ],
  );
  assert.deepEqual(
    diffCommands(
      base,
      commandTokens(
        "node dist/cli.js cross-backup init --agent <name> --shares-out <d> --agent <x>",
      ),
    ),
    ["duplicate in copy: --agent", 'value of --agent: "<name>" vs "<x>"'],
  );
  assert.deepEqual(
    diffCommands(
      commandTokens(
        "node dist/cli.js cross-backup init --agent <name> --shares-out <d> --agent <x>",
      ),
      base,
    ),
    ["duplicate in source: --agent", 'value of --agent: "<x>" vs "<name>"'],
  );
});

/** Body of a top-level `async function name(` in cli.ts, up to the next one. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`\nasync function ${name}(`);
  assert.ok(start >= 0, `function not found: ${name}`);
  // Grenze = nächste Funktion auf oberster Ebene, async oder nicht (Kiro, #63)
  const rest = src.slice(start + 1).search(/\n(async )?function /);
  return src.slice(start, rest < 0 ? undefined : start + 1 + rest);
}

test("init really knows --force (the doc does not promise a flag the CLI lacks)", () => {
  // Scoped to the init command, not the whole CLI (Kiro, review #62):
  // --force read by another command would not make init accept it.
  const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
  assert.match(
    functionBody(cli, "crossBackupInitCmd"),
    /hasFlag\(args, "--force"\)/,
  );
  assert.doesNotMatch(
    functionBody(cli, "crossBackupInitCmd").slice(1),
    /\n(async )?function /,
    "scope check: the init body must stop at the next top-level function",
  );
  assert.doesNotMatch(
    functionBody(cli, "crossBackupStatusCmd"),
    /hasFlag\(args, "--force"\)/,
    "scope check: a command without --force must not match",
  );
});
