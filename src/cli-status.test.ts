/**
 * CLI tests for `cross-backup status --local-passphrase-file` (Tyto, 09 Oct):
 * the file branch used to be checked by hand only. These pin it down.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { init, receiveShare, hashShare, decryptShare } from "./cross-backup.js";

// Built as CommonJS: __dirname is dist/ next to the compiled cli.js.
const CLI = join(__dirname, "cli.js");

function runStatus(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [CLI, "cross-backup", "status", ...args],
    {
      encoding: "utf8",
      timeout: 20000,
    },
  );
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
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "nope"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 1);
    assert.match(r.out, /not found/);
  });

  it("empty file -> exit 1", () => {
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp-empty"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 1);
    assert.match(r.out, /empty/);
  });

  it("right passphrase, nothing received yet -> exit 2 (not done), local + all shares ok", () => {
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp-ok"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /Triangle: INCOMPLETE/);
    assert.match(r.out, /Local share: ✅ OK/);
    assert.match(r.out, /All stored shares: ✅/);
  });

  it("wrong passphrase -> exit 1 (red test: the check CAN turn red)", () => {
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp-wrong"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Local share: ❌ FAILED/);
    // Tyto: the secret must never be echoed, not even on failure.
    assert.ok(
      !r.out.includes("not-the-key"),
      "wrong passphrase leaked to output",
    );
    assert.ok(!r.out.includes("cli-key"), "real passphrase leaked to output");
  });

  it("local ok but a PARTNER share tampered -> exit 1, Triangle not COMPLETE (Kiro)", async () => {
    const d = mkdtempSync(join(tmpdir(), "exuvia-cli-tamper-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pass", "cli-key", d);
      // Without tampering this state would be COMPLETE (both partners' shares
      // received), so only the allSharesError check can make it INCOMPLETE.
      for (const from of ["tyto", "kiro"]) {
        const hex = `${from}-share-for-nyx`;
        receiveShare(from, hex, hashShare(hex), "cli-key", undefined, d);
      }
      const before = runStatus([
        "--local-passphrase-file",
        join(dir, "lpp-ok"),
        "--state-dir",
        d,
      ]);
      assert.match(
        before.out,
        /Triangle: COMPLETE ✅/,
        "precondition: untampered state is COMPLETE",
      );
      const p = join(d, ".exuvia-cross-backup.json");
      const raw = JSON.parse(readFileSync(p, "utf8"));
      raw.partners[1].shareHash = "0".repeat(64);
      writeFileSync(p, JSON.stringify(raw));
      const r = runStatus([
        "--local-passphrase-file",
        join(dir, "lpp-ok"),
        "--state-dir",
        d,
      ]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Local share: ✅ OK/);
      assert.match(r.out, /All stored shares: ❌/);
      assert.doesNotMatch(r.out, /Triangle: COMPLETE/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("RECEIVED share tampered -> exit 1, not COMPLETE (received file was never checked)", async () => {
    const d = mkdtempSync(join(tmpdir(), "exuvia-cli-rtamper-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pass", "cli-key", d);
      for (const from of ["tyto", "kiro"]) {
        const h = `${from}-share-for-nyx`;
        receiveShare(from, h, hashShare(h), "cli-key", undefined, d);
      }
      const ok = runStatus([
        "--local-passphrase-file",
        join(dir, "lpp-ok"),
        "--state-dir",
        d,
      ]);
      assert.equal(ok.code, 0, ok.out);
      assert.match(
        ok.out,
        /Triangle: COMPLETE ✅/,
        "precondition: untampered is COMPLETE",
      );
      const p = join(d, ".exuvia-received-shares.json");
      const raw = JSON.parse(readFileSync(p, "utf8"));
      raw.kiro.shareHash = "0".repeat(64);
      writeFileSync(p, JSON.stringify(raw));
      // Proof the manipulation arrived on disk.
      assert.equal(
        JSON.parse(readFileSync(p, "utf8")).kiro.shareHash,
        "0".repeat(64),
      );
      const r = runStatus([
        "--local-passphrase-file",
        join(dir, "lpp-ok"),
        "--state-dir",
        d,
      ]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /kiro: ❌/);
      assert.doesNotMatch(r.out, /Triangle: COMPLETE/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("share from a NON-partner does not count toward COMPLETE (Kiro, 11 Oct)", async () => {
    const d = mkdtempSync(join(tmpdir(), "exuvia-cli-stranger-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pass", "cli-key", d);
      for (const from of ["tyto", "mallory"]) {
        const h = `${from}-share-for-nyx`;
        receiveShare(from, h, hashShare(h), "cli-key", undefined, d);
      }
      // Proof the setup is what we think: two received shares, one of them not a partner.
      const raw = JSON.parse(
        readFileSync(join(d, ".exuvia-received-shares.json"), "utf8"),
      );
      assert.deepEqual(Object.keys(raw).sort(), ["mallory", "tyto"]);
      const r = runStatus([
        "--local-passphrase-file",
        join(dir, "lpp-ok"),
        "--state-dir",
        d,
      ]);
      assert.equal(r.code, 1, r.out);
      assert.doesNotMatch(r.out, /Triangle: COMPLETE/, r.out);
      assert.match(r.out, /not a partner: mallory/);
      assert.match(r.out, /nothing received yet from: kiro/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("right passphrase is not echoed either", () => {
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp-ok"),
      "--state-dir",
      dir,
    ]);
    assert.ok(!r.out.includes("cli-key"), "passphrase leaked to output");
  });
});

function runReceive(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [CLI, "cross-backup", "receive", ...args],
    {
      encoding: "utf8",
      timeout: 20000,
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("cli — cross-backup receive --local-passphrase-file", () => {
  let dir: string;
  const hex = "tyto-share-for-nyx";
  const statePath = () => join(dir, ".exuvia-cross-backup.json");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-receive-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp-ok"), "cli-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-empty"), "  \n", { mode: 0o600 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("missing file -> exit 1 and state file untouched", () => {
    const before = readFileSync(statePath(), "utf8");
    const r = runReceive([
      "--from",
      "tyto",
      "--share",
      hex,
      "--hash",
      hashShare(hex),
      "--local-passphrase-file",
      join(dir, "nope"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not found/);
    assert.equal(
      readFileSync(statePath(), "utf8"),
      before,
      "state changed on abort",
    );
  });

  it("empty file -> exit 1 and state file untouched", () => {
    const before = readFileSync(statePath(), "utf8");
    const r = runReceive([
      "--from",
      "tyto",
      "--share",
      hex,
      "--hash",
      hashShare(hex),
      "--local-passphrase-file",
      join(dir, "lpp-empty"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /empty/);
    assert.equal(
      readFileSync(statePath(), "utf8"),
      before,
      "state changed on abort",
    );
  });

  it("file passphrase -> share stored, readable by status, secret not echoed", () => {
    const r = runReceive([
      "--from",
      "tyto",
      "--share",
      hex,
      "--hash",
      hashShare(hex),
      "--local-passphrase-file",
      join(dir, "lpp-ok"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verified and stored/);
    assert.ok(!r.out.includes("cli-key"), "passphrase leaked to output");
    // Received shares live in their own file, not in state.partners (those are
    // the shares we SENT). Check the file receive actually writes, and that the
    // stored value decrypts with the passphrase from the file.
    const rec = JSON.parse(
      readFileSync(join(dir, ".exuvia-received-shares.json"), "utf8"),
    );
    assert.ok(rec.tyto?.shareHex, "tyto share was not stored");
    assert.equal(decryptShare(rec.tyto.shareHex, "cli-key"), hex);
    // A separate process with the same file can decrypt what receive wrote.
    const s = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp-ok"),
      "--state-dir",
      dir,
    ]);
    // Only tyto received so far: readable, but not done -> 2 (Kiro: 0/1/2).
    assert.equal(s.code, 2, s.out);
    assert.match(s.out, /nothing received yet from: kiro/);
    assert.match(s.out, /All stored shares: ✅/);
  });
});

describe("cross-backup receive --share-file", () => {
  let dir: string;
  const hex = "tyto-share-for-nyx";
  const statePath = () => join(dir, ".exuvia-cross-backup.json");
  const base = () => [
    "--from",
    "tyto",
    "--hash",
    hashShare(hex),
    "--local-passphrase-file",
    join(dir, "lpp"),
    "--state-dir",
    dir,
  ];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-sharefile-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp"), "cli-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "share-ok"), hex + "\n", { mode: 0o600 });
    writeFileSync(join(dir, "share-empty"), " \n", { mode: 0o600 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, file, msg] of [
    ["missing", "nope", /Share file not found/],
    ["empty", "share-empty", /Share file is empty/],
  ] as const) {
    it(`${name} share file -> exit 1, nothing written`, () => {
      const before = readFileSync(statePath(), "utf8");
      const r = runReceive([...base(), "--share-file", join(dir, file)]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, msg);
      assert.equal(
        readFileSync(statePath(), "utf8"),
        before,
        "state changed on abort",
      );
      assert.ok(
        !existsSync(join(dir, ".exuvia-received-shares.json")),
        "received file written on abort",
      );
    });
  }

  it("share from file -> stored, decrypts to the file content, share not in argv", () => {
    const args = [...base(), "--share-file", join(dir, "share-ok")];
    assert.ok(!args.includes(hex), "test passes the share in argv");
    const r = runReceive(args);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /verified and stored/);
    const rec = JSON.parse(
      readFileSync(join(dir, ".exuvia-received-shares.json"), "utf8"),
    );
    assert.equal(decryptShare(rec.tyto.shareHex, "cli-key"), hex);
  });
});

function runRotate(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [CLI, "cross-backup", "rotate", ...args],
    {
      encoding: "utf8",
      timeout: 20000,
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Kiro, 11 Oct: rotate took the local passphrase only via argv.
describe("cli — cross-backup rotate --local-passphrase-file", () => {
  let dir: string;
  const statePath = () => join(dir, ".exuvia-cross-backup.json");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-rotate-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp-ok"), "cli-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-empty"), "  \n", { mode: 0o600 });
    writeFileSync(join(dir, "pp"), "pass\n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-wrong"), "cli-kez\n", { mode: 0o600 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, file, msg] of [
    ["missing", "nope", /not found/],
    ["empty", "lpp-empty", /empty/],
    // Tyto, 12 Oct: a readable file with the WRONG passphrase must not rotate.
    ["wrong", "lpp-wrong", /does not match the stored state/],
  ] as const) {
    it(`${name} file -> exit 1 and state file untouched`, () => {
      const before = readFileSync(statePath(), "utf8");
      const r = runRotate([
        "--passphrase-file",
        join(dir, "pp"),
        "--local-passphrase-file",
        join(dir, file),
        "--state-dir",
        dir,
      ]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, msg);
      assert.equal(
        readFileSync(statePath(), "utf8"),
        before,
        "state changed on abort",
      );
    });
  }

  it("correct file -> version bumped, new shares encrypted with the stored passphrase (wrong file is rejected above), secret not echoed", () => {
    const v0 = JSON.parse(readFileSync(statePath(), "utf8"));
    const r = runRotate([
      "--passphrase-file",
      join(dir, "pp"),
      "--local-passphrase-file",
      join(dir, "lpp-ok"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 0, r.out);
    const v1 = JSON.parse(readFileSync(statePath(), "utf8"));
    // the manipulation must have arrived: the state really changed
    assert.equal(v1.version, v0.version + 1);
    assert.notEqual(v1.localShareHex, v0.localShareHex);
    assert.equal(
      hashShare(decryptShare(v1.localShareHex, "cli-key")),
      v1.localShareHash,
    );
    for (const p of v1.partners) {
      assert.equal(hashShare(decryptShare(p.shareHex, "cli-key")), p.shareHash);
      // Kiro, 12 Oct: the partner shares must be new too, not just the local one.
      const old = v0.partners.find((o: { id: string }) => o.id === p.id);
      assert.ok(old, `partner ${p.id} missing before rotate`);
      assert.notEqual(
        p.shareHash,
        old.shareHash,
        `partner ${p.id} share not rotated`,
      );
    }
    assert.ok(!r.out.includes("cli-key"), "local passphrase leaked to output");
  });
});
