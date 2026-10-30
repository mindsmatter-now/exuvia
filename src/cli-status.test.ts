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
  statSync,
  chmodSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  init,
  receiveShare,
  hashShare,
  decryptShare,
  STATE_FILE,
} from "./cross-backup.js";

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

function runReceive(args: string[], input?: string) {
  const r = spawnSync(
    process.execPath,
    [CLI, "cross-backup", "receive", ...args],
    {
      encoding: "utf8",
      timeout: 20000,
      input,
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
    assert.equal(
      statSync(join(dir, ".exuvia-received-shares.json")).mode & 0o777,
      0o600,
      "received-shares file must be 0600",
    );
  });
});

describe("cross-backup receive --share-file - (stdin) and guards (Tyto, review #19)", () => {
  let dir: string;
  const hex = "kiro-share-for-nyx";
  const base = () => [
    "--from",
    "kiro",
    "--hash",
    hashShare(hex),
    "--local-passphrase-file",
    join(dir, "lpp"),
    "--state-dir",
    dir,
  ];
  const received = () => join(dir, ".exuvia-received-shares.json");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-stdin-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp"), "cli-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "share-open"), hex + "\n", { mode: 0o644 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("--share-file - reads stdin: stored, decrypts, nothing in argv", () => {
    const args = [...base(), "--share-file", "-"];
    assert.ok(!args.includes(hex), "test passes the share in argv");
    const r = runReceive(args, hex + "\n");
    assert.equal(r.code, 0, r.out);
    const rec = JSON.parse(readFileSync(received(), "utf8"));
    assert.equal(decryptShare(rec.kiro.shareHex, "cli-key"), hex);
    rmSync(received());
  });

  it("empty stdin -> exit 1, nothing written", () => {
    const r = runReceive([...base(), "--share-file", "-"], "  \n");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /from stdin is empty/);
    assert.ok(!existsSync(received()), "received file written on abort");
  });

  it("--share-file and --share together -> exit 1, nothing written", () => {
    const r = runReceive([
      ...base(),
      "--share-file",
      join(dir, "share-open"),
      "--share",
      hex,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /both given/);
    assert.ok(!existsSync(received()), "received file written on abort");
  });

  it("two secrets from stdin -> exit 1 with a clear message, nothing written", () => {
    const args = [
      "--from",
      "kiro",
      "--hash",
      hashShare(hex),
      "--local-passphrase-file",
      "-",
      "--state-dir",
      dir,
      "--share-file",
      "-",
    ];
    const r = runReceive(args, hex + "\n");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /only one secret can come from stdin/);
    assert.ok(!existsSync(received()), "received file written on abort");
  });

  it("existing 0644 received-shares is REPLACED (new inode), ends 0600, no temp left", () => {
    // Inode check (Tyto, review eb471ee): an in-place overwrite keeps the inode
    // and is what opens the 0644 window and the crash risk. A replaced file
    // proves the temp+rename mechanism is actually used.
    writeFileSync(received(), "{}", { mode: 0o644 });
    chmodSync(received(), 0o644);
    const ino = statSync(received()).ino;
    const r = runReceive([...base(), "--share-file", "-"], hex + "\n");
    assert.equal(r.code, 0, r.out);
    assert.notEqual(
      statSync(received()).ino,
      ino,
      "file was overwritten in place",
    );
    assert.equal(statSync(received()).mode & 0o777, 0o600);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".tmp-")),
      [],
      "temp file left behind",
    );
    rmSync(received());
  });

  it("group/world-readable share file -> warning, still works", () => {
    const r = runReceive([...base(), "--share-file", join(dir, "share-open")]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /readable by group\/others/);
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

  const baks = () =>
    readdirSync(dir).filter((f) =>
      f.startsWith(".exuvia-cross-backup.json.bak-"),
    );

  it("rotate keeps the old state (version N) as .bak-<time>, 0600, byte-identical (runbook ⚪ 12 Oct)", () => {
    const oldBytes = readFileSync(statePath());
    const before = new Set(baks());
    const r = runRotate([
      "--passphrase-file",
      join(dir, "pp"),
      "--local-passphrase-file",
      join(dir, "lpp-ok"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 0, r.out);
    const fresh = baks().filter((f) => !before.has(f));
    assert.equal(fresh.length, 1, `expected one new .bak, got ${fresh}`);
    assert.ok(
      readFileSync(join(dir, fresh[0])).equals(oldBytes),
      ".bak is not the old state",
    );
    assert.equal(statSync(join(dir, fresh[0])).mode & 0o777, 0o600);
    assert.ok(!readFileSync(statePath()).equals(oldBytes), "state not rotated");
    assert.match(r.out, /kept as .*\.bak-/);
  });

  it("refused rotate (wrong local passphrase) leaves no .bak behind", () => {
    const before = baks().length;
    const r = runRotate([
      "--passphrase-file",
      join(dir, "pp"),
      "--local-passphrase-file",
      join(dir, "lpp-wrong"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.equal(baks().length, before, "a refused rotate left a backup");
  });
});

function runInit(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [CLI, "cross-backup", "init", ...args],
    {
      encoding: "utf8",
      timeout: 60000,
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("cross-backup init: same local-passphrase guards as receive (Kiro, review #20)", () => {
  let dir: string;
  const state = () => join(dir, ".exuvia-cross-backup.json");
  const base = () => [
    "--agent",
    "nyx",
    "--partners",
    "tyto,kiro",
    "--passphrase",
    "init-pass",
    "--state-dir",
    dir,
  ];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-init-"));
    writeFileSync(join(dir, "lpp"), "init-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-empty"), " \n", { mode: 0o600 });
    writeFileSync(join(dir, "lpp-open"), "init-key\n", { mode: 0o644 });
    chmodSync(join(dir, "lpp-open"), 0o644);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [name, extra, msg] of [
    [
      "both flags",
      () => [
        "--local-passphrase-file",
        join(dir, "lpp"),
        "--local-passphrase",
        "x",
      ],
      /both given/,
    ],
    [
      "empty file",
      () => ["--local-passphrase-file", join(dir, "lpp-empty")],
      /file is empty/,
    ],
    ["stdin", () => ["--local-passphrase-file", "-"], /not stdin/],
  ] as const) {
    it(`${name} -> exit 1, no state written`, () => {
      const r = runInit([...base(), ...extra()]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, msg);
      assert.ok(!existsSync(state()), "state written on abort");
    });
  }

  it("--local-passphrase without a file -> exit 1, no state written (Tyto + Kiro, 18 Oct)", () => {
    const r = runInit([...base(), "--local-passphrase", "init-key"]);
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.out,
      /needs --local-passphrase-file <file>, not --local-passphrase/,
    );
    assert.ok(!existsSync(state()), "state written on abort");
  });

  it("group/world-readable lpp file -> warning, init still works", () => {
    const r = runInit([
      ...base(),
      "--local-passphrase-file",
      join(dir, "lpp-open"),
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /readable by group\/others/);
    assert.ok(existsSync(state()));
  });
});

describe("cross-backup init over an existing state (Kiro, 18 Oct)", () => {
  let dir: string;
  const state = () => join(dir, ".exuvia-cross-backup.json");
  const sha = () =>
    createHash("sha256").update(readFileSync(state())).digest("hex");
  const args = () => [
    "--agent",
    "nyx",
    "--partners",
    "tyto,kiro",
    "--passphrase",
    "init-pass",
    "--state-dir",
    dir,
    "--local-passphrase-file",
    join(dir, "lpp"),
  ];
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-reinit-"));
    writeFileSync(join(dir, "lpp"), "init-key\n", { mode: 0o600 });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("second init without --force -> exit 1, state byte-identical", () => {
    assert.equal(runInit(args()).code, 0);
    const before = sha();
    const r = runInit(args());
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /already exists.*rotate.*--force/s);
    assert.equal(sha(), before, "existing state was replaced");
  });

  it("second init with --force replaces it on purpose", () => {
    const before = sha();
    const r = runInit([...args(), "--force"]);
    assert.equal(r.code, 0, r.out);
    assert.notEqual(sha(), before, "--force must actually write a new state");
  });

  it("--force keeps the old state as .bak-<time>, 0600, byte-identical (Kiro, review #34)", () => {
    const oldBytes = readFileSync(state());
    const r = runInit([...args(), "--force"]);
    assert.equal(r.code, 0, r.out);
    const baks = readdirSync(dir).filter((f) =>
      f.startsWith(".exuvia-cross-backup.json.bak-"),
    );
    const match = baks.filter((f) =>
      readFileSync(join(dir, f)).equals(oldBytes),
    );
    assert.equal(match.length, 1, `no .bak with the old bytes: ${baks}`);
    assert.equal(statSync(join(dir, match[0])).mode & 0o777, 0o600);
    assert.ok(!readFileSync(state()).equals(oldBytes), "state not replaced");
  });

  it("the CLI guards the same file the library writes (STATE_FILE, Kiro)", () => {
    assert.equal(STATE_FILE, ".exuvia-cross-backup.json");
    assert.ok(existsSync(join(dir, STATE_FILE)));
    const r = runInit(args());
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(join(dir, STATE_FILE)), r.out);
  });
});

describe("cross-backup recover --local-passphrase-file / --shares-file", () => {
  let dir: string;
  let nyxDir: string;
  let kiroHex: string;
  const SECRET = "RecoverCli!2026";

  function runRecover(args: string[], input?: string) {
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        "cross-backup",
        "recover",
        "--agent",
        "nyx",
        "--state-dir",
        dir,
        ...args,
      ],
      { encoding: "utf8", timeout: 30000, input },
    );
    return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-recover-"));
    nyxDir = mkdtempSync(join(tmpdir(), "exuvia-cli-recover-nyx-"));
    const res = await init("nyx", ["tyto", "kiro"], SECRET, "nyx-key", nyxDir);
    const t = res.sharesToSend.get("tyto")!;
    kiroHex = res.sharesToSend.get("kiro")!.hex;
    receiveShare("nyx", t.hex, t.hash, "tyto-key", undefined, dir);
    writeFileSync(join(dir, "lpp"), "tyto-key\n", { mode: 0o600 });
    writeFileSync(join(dir, "shares"), kiroHex + "\n", { mode: 0o600 });
    writeFileSync(join(dir, "shares-empty"), "\n \n", { mode: 0o600 });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(nyxDir, { recursive: true, force: true });
  });

  it("both from files -> passphrase on stdout, no secret in argv", () => {
    const args = [
      "--local-passphrase-file",
      join(dir, "lpp"),
      "--shares-file",
      join(dir, "shares"),
    ];
    assert.ok(!args.includes(kiroHex) && !args.includes("tyto-key"));
    const r = runRecover(args);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout, SECRET, r.out); // stdout = exactly the passphrase (pipe-safe)
  });

  it("shares from stdin -> recovers", () => {
    const r = runRecover(
      ["--local-passphrase-file", join(dir, "lpp"), "--shares-file", "-"],
      kiroHex + "\n",
    );
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout, SECRET, r.out); // stdout = exactly the passphrase (pipe-safe)
  });

  it("redirected to a file -> file content === passphrase (status lines on stderr)", () => {
    const out = join(dir, "pp-out");
    const r = spawnSync(
      "sh",
      [
        "-c",
        `"${process.execPath}" "${CLI}" cross-backup recover --agent nyx --state-dir "${dir}" --local-passphrase-file "${join(dir, "lpp")}" --shares-file "${join(dir, "shares")}" > "${out}"`,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), SECRET);
    assert.match(r.stderr, /Recovery successful/);
  });

  it("empty shares file -> exit 1, no passphrase", () => {
    const r = runRecover([
      "--local-passphrase-file",
      join(dir, "lpp"),
      "--shares-file",
      join(dir, "shares-empty"),
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Shares file is empty/);
    assert.ok(!r.out.includes(SECRET));
  });

  it("--shares-file and --shares together -> exit 1", () => {
    const r = runRecover([
      "--local-passphrase-file",
      join(dir, "lpp"),
      "--shares-file",
      join(dir, "shares"),
      "--shares",
      kiroHex,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /both given/);
    assert.ok(!r.out.includes(SECRET));
  });

  it("two secrets from stdin -> exit 1", () => {
    const r = runRecover(
      ["--local-passphrase-file", "-", "--shares-file", "-"],
      "tyto-key\n",
    );
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /only one secret can come from stdin/);
  });
});

// Rudel 26.10.2026 (PR 1 of the `previous` plan): a receive that overwrites a
// share we already hold must say so loudly, and status must show per partner
// which version + hash we hold, so a silent swap is visible afterwards.
describe("cross-backup receive — replace is loud, status shows version + hash", () => {
  let dir: string;
  const a = "kiro-share-round-a";
  const b = "kiro-share-round-b";
  const args = (hex: string) => [
    "--from",
    "kiro",
    "--hash",
    hashShare(hex),
    "--local-passphrase-file",
    join(dir, "lpp"),
    "--state-dir",
    dir,
    "--share-file",
    "-",
  ];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-replace-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp"), "cli-key\n", { mode: 0o600 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("first receive: stored as v1, no REPLACED warning", () => {
    const r = runReceive(args(a), a + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /stored as v1!/);
    assert.doesNotMatch(r.out, /REPLACED/);
  });

  it("second receive: warns REPLACED with old version + old hash and new hash", () => {
    const r = runReceive(args(b), b + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /stored as v2!/);
    assert.match(r.out, /REPLACED the share you held for kiro: v1/);
    assert.ok(r.out.includes(hashShare(a).slice(0, 16)), "old hash missing");
    assert.ok(r.out.includes(hashShare(b).slice(0, 16)), "new hash missing");
    assert.match(r.out, /previous share is NOT kept/);
    assert.doesNotMatch(r.out, /same share content/);
  });

  it("same share again: still loud, but says it is the same content", () => {
    const r = runReceive(args(b), b + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /REPLACED the share you held for kiro: v2/);
    assert.match(r.out, /same share content/);
  });

  it("status lists the held version and hash per partner", () => {
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp"),
      "--state-dir",
      dir,
    ]);
    assert.ok(
      r.out.includes(`kiro: ✅ v3 hash ${hashShare(b).slice(0, 16)}…`),
      r.out,
    );
  });
});

describe("cross-backup receive --round, init/rotate/status print the round id", () => {
  let dir: string;
  const a = "kiro-share-round-cli-a";
  const b = "kiro-share-round-cli-b";
  const R1 = "0123456789abcdef0123456789abcdef";
  const R2 = "fedcba9876543210fedcba9876543210";
  const args = (hex: string, extra: string[] = []) => [
    "--from",
    "kiro",
    "--hash",
    hashShare(hex),
    "--local-passphrase-file",
    join(dir, "lpp"),
    "--state-dir",
    dir,
    "--share-file",
    "-",
    ...extra,
  ];
  const received = () => join(dir, ".exuvia-received-shares.json");
  const stored = () =>
    existsSync(received())
      ? JSON.parse(readFileSync(received(), "utf8")).kiro
      : undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "exuvia-cli-round-"));
    await init("nyx", ["tyto", "kiro"], "pass", "cli-key", dir);
    writeFileSync(join(dir, "lpp"), "cli-key\n", { mode: 0o600 });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [label, bad] of [
    ["uppercase, right length (Kiro, review #48)", "A".repeat(32)],
    ["too short", "abc"],
    ["non-hex", "z".repeat(32)],
  ] as const) {
    it(`--round ${label} -> exit 1, nothing written`, () => {
      const r = runReceive(args(a, ["--round", bad]), a + "\n");
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /--round must be 32 lowercase hex/);
      assert.ok(!existsSync(received()), "received file written on bad --round");
    });
  }

  it("--round without a value -> exit 1, nothing written", () => {
    const r = runReceive(args(a, ["--round"]), a + "\n");
    assert.equal(r.code, 1, r.out);
    assert.ok(!existsSync(received()));
  });

  it("valid --round is stored and printed", () => {
    const r = runReceive(args(a, ["--round", R1]), a + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Round: ${R1}`));
    assert.equal(stored().roundId, R1);
  });

  it("replace WITHOUT --round says the old round id is dropped (Tyto, review #48)", () => {
    const r = runReceive(args(b), b + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Round: ${R1} → \\(none given\\) — old round id dropped`));
    assert.equal(stored().roundId, undefined);
  });

  it("replace with a new round shows old → new", () => {
    const r = runReceive(args(a, ["--round", R2]), a + "\n");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`Round: \\(none\\) → ${R2}`));
  });

  it("same round again says same round", () => {
    const r = runReceive(args(a, ["--round", R2]), a + "\n");
    assert.match(r.out, new RegExp(`Round: ${R2} → ${R2} — same round`));
  });

  it("status prints our round and the held round prefix", () => {
    const own = JSON.parse(
      readFileSync(join(dir, STATE_FILE), "utf8"),
    ).roundId;
    const r = runStatus([
      "--local-passphrase-file",
      join(dir, "lpp"),
      "--state-dir",
      dir,
    ]);
    assert.ok(r.out.includes(`Round: ${own}`), r.out);
    assert.ok(r.out.includes(`round ${R2.slice(0, 8)}…`), r.out);
  });

  it("rotate prints the kept round id", () => {
    const own = JSON.parse(
      readFileSync(join(dir, STATE_FILE), "utf8"),
    ).roundId;
    const r = runRotate([
      "--passphrase",
      "pass",
      "--local-passphrase-file",
      join(dir, "lpp"),
      "--state-dir",
      dir,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes(`Round: ${own} (unchanged by rotate)`), r.out);
  });
});
