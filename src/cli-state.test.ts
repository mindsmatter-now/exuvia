/**
 * The CLI's own state file (.exuvia-state.json) is written atomically, like
 * the cross-backup state since #29 (follow-up named in the #29 review).
 *
 * The crash/short-write cases are not repeated here: saveState goes through
 * writePrivateAtomic, and that is tested in cross-backup.test.ts (#29: short
 * write without throw, short write then ENOSPC, 0-byte write, real ulimit -f).
 * These tests pin the CLI wiring: 0600, no temp copy, readable errors, status
 * hints (Tyto, review #30).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  chmodSync,
  utimesSync,
} from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const CLI = join(__dirname, "cli.js");

function backup(dir: string) {
  const r = spawnSync(
    process.execPath,
    [CLI, "backup", "--workspace", dir, "--passphrase-file", join(dir, "pp")],
    {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, EXUVIA_AGENT: "t" },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("cli — saveState is atomic", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-state-"));
    writeFileSync(join(dir, "SOUL.md"), "# soul\n");
    writeFileSync(join(dir, "pp"), "correct horse battery staple 2026");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a complete 0600 state file and leaves no temp copy", () => {
    const r = backup(dir);
    assert.equal(r.code, 0, r.out);
    const path = join(dir, ".exuvia-state.json");
    const st = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(st.lastBackup.fileCount, 1);
    // writePrivateAtomic creates the file 0600; plain writeFileSync gives 0644
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".tmp-")),
      [],
    );
  });

  it("a second backup keeps history and still leaves no temp copy", () => {
    writeFileSync(join(dir, "SOUL.md"), "# soul v2\n");
    const r = backup(dir);
    assert.equal(r.code, 0, r.out);
    const st = JSON.parse(
      readFileSync(join(dir, ".exuvia-state.json"), "utf8"),
    );
    assert.equal(st.history.length, 1);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".tmp-")),
      [],
    );
  });
});

function status(dir: string) {
  const r = spawnSync(process.execPath, [CLI, "status", "--workspace", dir], {
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("cli — status hints (Tyto + Kiro, review #29/#30)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-hints-"));
    writeFileSync(join(dir, "SOUL.md"), "# soul\n");
    writeFileSync(join(dir, "pp"), "correct horse battery staple 2026");
    assert.equal(backup(dir).code, 0);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("a clean workspace shows no hints", () => {
    const r = status(dir);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Leftover temp file|readable by others/);
  });

  it("an old .tmp- copy of a state file is reported and NOT deleted", () => {
    const tmp = join(dir, ".exuvia-cross-backup.json.tmp-123-456");
    writeFileSync(tmp, "{}");
    const old = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(tmp, old, old);
    const r = status(dir);
    assert.match(
      r.out,
      /Leftover temp file \.exuvia-cross-backup\.json\.tmp-123-456/,
    );
    assert.ok(
      readdirSync(dir).includes(".exuvia-cross-backup.json.tmp-123-456"),
      "status must not delete anything",
    );
    rmSync(tmp);
  });

  it("a fresh .tmp- copy (save may be in progress) is not reported", () => {
    const tmp = join(dir, ".exuvia-state.json.tmp-1-2");
    writeFileSync(tmp, "{}");
    const r = status(dir);
    assert.doesNotMatch(r.out, /Leftover temp file/);
    rmSync(tmp);
  });

  it("an unrelated .tmp- file is not reported", () => {
    const tmp = join(dir, "notes.md.tmp-1-2");
    writeFileSync(tmp, "x");
    const old = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(tmp, old, old);
    assert.doesNotMatch(status(dir).out, /Leftover temp file/);
    rmSync(tmp);
  });

  it("a 0644 state file gets an ⓘ hint and reading does not chmod it", () => {
    const f = join(dir, ".exuvia-state.json");
    chmodSync(f, 0o644);
    assert.equal(
      statSync(f).mode & 0o777,
      0o644,
      "the manipulation must have landed",
    );
    const r = status(dir);
    assert.match(
      r.out,
      /ⓘ\s+\.exuvia-state\.json is 0644 .*next save sets it to 0600/,
    );
    assert.equal(
      statSync(f).mode & 0o777,
      0o644,
      "status must not change modes",
    );
    writeFileSync(join(dir, "SOUL.md"), "# soul v3\n");
    assert.equal(backup(dir).code, 0);
    assert.equal(statSync(f).mode & 0o777, 0o600, "the next save heals it");
    assert.doesNotMatch(status(dir).out, /readable by others/);
  });
});

describe("cli — a failing state save is one readable line (Kiro, review #30)", () => {
  it("ulimit -f: exit 1, no stack trace, names the orphan .enc, old state intact", () => {
    if (process.platform !== "linux") return; // needs bash ulimit; Node ignores SIGXFSZ (Tyto, review #29)
    const dir = mkdtempSync(join(tmpdir(), "exuvia-cli-efbig-"));
    try {
      writeFileSync(join(dir, "SOUL.md"), "# soul\n");
      writeFileSync(join(dir, "pp"), "correct horse battery staple 2026");
      assert.equal(backup(dir).code, 0);
      const statePath = join(dir, ".exuvia-state.json");
      // Pad the state so the next save is larger than the ulimit, while the
      // small .enc still fits (Kiro's probe).
      const st = JSON.parse(readFileSync(statePath, "utf8"));
      st.pad = "x".repeat(2_000_000);
      writeFileSync(statePath, JSON.stringify(st));
      chmodSync(statePath, 0o600);
      const sha = (p: string) =>
        createHash("sha256").update(readFileSync(p)).digest("hex");
      const before = sha(statePath);
      writeFileSync(join(dir, "SOUL.md"), "# soul v2\n");
      const r = spawnSync(
        "bash",
        [
          "-c",
          `ulimit -f 1000; exec "$0" "$@"`,
          process.execPath,
          CLI,
          "backup",
          "--workspace",
          dir,
          "--passphrase-file",
          join(dir, "pp"),
        ],
        {
          encoding: "utf8",
          timeout: 60000,
          env: { ...process.env, EXUVIA_AGENT: "t" },
        },
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 1, out);
      assert.match(out, /❌ State could not be saved: EFBIG/);
      assert.match(
        out,
        /exuvia-t-.*\.enc was already written but is not recorded in the state/,
      );
      assert.doesNotMatch(out, /\n\s+at /, "no Node stack trace");
      assert.equal(sha(statePath), before, "old state must be byte-identical");
      assert.deepEqual(
        readdirSync(dir).filter((f) => f.includes(".tmp-")),
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
