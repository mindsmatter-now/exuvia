/**
 * CLI tests for `cross-backup status --local-passphrase-file` (Tyto, 09 Oct):
 * the file branch used to be checked by hand only. These pin it down.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { init } from "./cross-backup.js";

// Built as CommonJS: __dirname is dist/ next to the compiled cli.js.
const CLI = join(__dirname, "cli.js");

function runStatus(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "cross-backup", "status", ...args], {
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("cli — cross-backup status --local-passphrase-file", () => {
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-status-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp-ok"), "cli-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-empty"), "  \n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-wrong"), "not-the-key\n", { mode: 0o600 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("missing file -> exit 1", () => {
    const r = runStatus(["--local-passphrase-file", join(dir, "nope"), "--state-dir", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out, /not found/);
  });

  it("empty file -> exit 1", () => {
    const r = runStatus(["--local-passphrase-file", join(dir, "lpp-empty"), "--state-dir", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out, /empty/);
  });

  it("right passphrase -> exit 0, local + all shares ok", () => {
    const r = runStatus(["--local-passphrase-file", join(dir, "lpp-ok"), "--state-dir", dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Local share: ✅ OK/);
    assert.match(r.out, /All stored shares: ✅/);
  });

  it("wrong passphrase -> exit 1 (red test: the check CAN turn red)", () => {
    const r = runStatus(["--local-passphrase-file", join(dir, "lpp-wrong"), "--state-dir", dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Local share: ❌ FAILED/);
  });
});
