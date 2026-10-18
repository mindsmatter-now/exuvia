/**
 * The CLI's own state file (.exuvia-state.json) is written atomically, like
 * the cross-backup state since #29 (follow-up named in the #29 review).
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
} from "fs";
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
