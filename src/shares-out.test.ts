/**
 * `--shares-out` for cross-backup init/rotate (Rudel, 06 Nov 2026).
 * Before: init/rotate printed `share.hex.slice(0, 32)...` only, so Phase 2
 * had no share and people reached into the state file (13 May).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
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
import { init, hashShare, loadState, STATE_FILE } from "./cross-backup.js";
import {
  checkSharesOutDir,
  writeSharesOut,
  shareFileName,
  hashFileName,
} from "./shares-out.js";

const CLI = join(__dirname, "cli.js");

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, "cross-backup", ...args], {
    encoding: "utf8",
    timeout: 60000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function outDir(root: string, name: string): string {
  const d = join(root, name);
  mkdirSync(d, { mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

describe("cross-backup init --shares-out", () => {
  let root: string;
  let stateDir: string;
  let out: string;
  let initOut = "";
  const initArgs = (extra: string[]) => [
    "init",
    "--agent",
    "nyx",
    "--partners",
    "tyto,kiro",
    "--passphrase",
    "so-pass",
    "--state-dir",
    stateDir,
    "--local-passphrase-file",
    join(root, "lpp"),
    ...extra,
  ];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "exuvia-shares-out-"));
    stateDir = join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    writeFileSync(join(root, "lpp"), "so-key\n", { mode: 0o600 });
    out = outDir(root, "out");
    const r = cli(initArgs(["--shares-out", out]));
    assert.equal(r.code, 0, r.out);
    initOut = r.out;
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("writes one 0600 share + hash file per partner, hash matches the state", () => {
    const state = loadState(stateDir)!;
    for (const p of state.partners) {
      const sf = join(out, shareFileName(p.id));
      const hf = join(out, hashFileName(p.id));
      assert.equal(statSync(sf).mode & 0o777, 0o600);
      assert.equal(statSync(hf).mode & 0o777, 0o600);
      const hex = readFileSync(sf, "utf8").trim();
      assert.equal(hashShare(hex), p.shareHash, `share for ${p.id}`);
      assert.equal(readFileSync(hf, "utf8").trim(), p.shareHash);
      assert.ok(initOut.includes(p.shareHash), "hash in terminal");
    }
  });

  it("the terminal never shows the share itself (not even a prefix)", () => {
    for (const id of ["tyto", "kiro"]) {
      const hex = readFileSync(join(out, shareFileName(id)), "utf8").trim();
      assert.ok(
        !initOut.includes(hex.slice(0, 16)),
        `share prefix of ${id} leaked`,
      );
    }
  });

  it("Phase 2 end to end: partner receives the file with the SENDER's hash", async () => {
    const tytoDir = join(root, "tyto");
    mkdirSync(tytoDir, { mode: 0o700 });
    await init("tyto", ["nyx", "kiro"], "t-pass", "t-key", tytoDir);
    writeFileSync(join(root, "t-lpp"), "t-key\n", { mode: 0o600 });
    const senderHash = readFileSync(
      join(out, hashFileName("tyto")),
      "utf8",
    ).trim();
    const r = cli([
      "receive",
      "--from",
      "nyx",
      "--share-file",
      join(out, shareFileName("tyto")),
      "--hash",
      senderHash,
      "--local-passphrase-file",
      join(root, "t-lpp"),
      "--state-dir",
      tytoDir,
    ]);
    assert.equal(r.code, 0, r.out);
  });

  // Kiro (05 Nov): on 13 May the receiver recomputed the hash, so a blob
  // passed. With the sender's hash a blob must be red.
  it("blob (encrypted state field) instead of the share + sender hash -> receive red", async () => {
    const kiroDir = join(root, "kiro");
    mkdirSync(kiroDir, { mode: 0o700 });
    await init("kiro", ["nyx", "tyto"], "k-pass", "k-key", kiroDir);
    writeFileSync(join(root, "k-lpp"), "k-key\n", { mode: 0o600 });
    const blob = loadState(stateDir)!.partners.find(
      (p) => p.id === "kiro",
    )!.shareHex;
    writeFileSync(join(root, "blob"), blob + "\n", { mode: 0o600 });
    const before = readFileSync(join(kiroDir, STATE_FILE), "utf8");
    const r = cli([
      "receive",
      "--from",
      "nyx",
      "--share-file",
      join(root, "blob"),
      "--hash",
      readFileSync(join(out, hashFileName("kiro")), "utf8").trim(),
      "--local-passphrase-file",
      join(root, "k-lpp"),
      "--state-dir",
      kiroDir,
    ]);
    assert.notEqual(r.code, 0, r.out);
    assert.equal(
      readFileSync(join(kiroDir, STATE_FILE), "utf8"),
      before,
      "blob stored",
    );
  });

  it("without --shares-out: hash only, no share prefix, hint to use --shares-out", () => {
    const sd = join(root, "state-plain");
    mkdirSync(sd, { mode: 0o700 });
    const r = cli([
      "init",
      "--agent",
      "nyx",
      "--partners",
      "tyto,kiro",
      "--passphrase",
      "so-pass",
      "--state-dir",
      sd,
      "--local-passphrase-file",
      join(root, "lpp"),
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /rerun with --shares-out/);
    assert.doesNotMatch(r.out, /[0-9a-f]{32}\.\.\./);
    for (const p of loadState(sd)!.partners)
      assert.ok(r.out.includes(p.shareHash));
  });
});

describe("cross-backup init --shares-out refusals: exit 1, nothing written", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "exuvia-shares-out-no-"));
    writeFileSync(join(root, "lpp"), "so-key\n", { mode: 0o600 });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const run = (stateDir: string, dir: string) =>
    cli([
      "init",
      "--agent",
      "nyx",
      "--partners",
      "tyto,kiro",
      "--passphrase",
      "so-pass",
      "--state-dir",
      stateDir,
      "--local-passphrase-file",
      join(root, "lpp"),
      "--shares-out",
      dir,
    ]);

  const fresh = (name: string) => {
    const s = join(root, `${name}-state`);
    mkdirSync(s, { mode: 0o700 });
    return s;
  };
  const assertNothing = (
    stateDir: string,
    dir: string,
    r: { code: number | null; out: string },
    msg: RegExp,
  ) => {
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, msg);
    assert.match(r.out, /Nothing was written/);
    assert.ok(!existsSync(join(stateDir, STATE_FILE)), "state written");
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      assert.deepEqual(
        readdirSync(dir).filter(
          (f) => f.endsWith(".share") || f.endsWith(".sha256"),
        ),
        [],
        "share file written",
      );
    }
  };

  // Tyto (05 Nov, after #42): `--shares-out .` in the repo -> exit 1, no file.
  it("inside a git worktree", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const dir = outDir(repo, "shares");
    const s = fresh("git");
    assertNothing(s, dir, run(s, dir), /inside a git worktree/);
  });

  it("the worktree root itself (`--shares-out .` in the repo)", () => {
    const repo = join(root, "repo2");
    mkdirSync(join(repo, ".git"), { recursive: true });
    chmodSync(repo, 0o700);
    const s = fresh("git2");
    assertNothing(s, repo, run(s, repo), /inside a git worktree/);
  });

  it("mode not 0700", () => {
    const dir = join(root, "open");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const s = fresh("open");
    assertNothing(s, dir, run(s, dir), /needs exactly 700/);
  });

  it("missing directory (never created for you)", () => {
    const dir = join(root, "nope");
    const s = fresh("nope");
    assertNothing(s, dir, run(s, dir), /does not exist/);
    assert.ok(!existsSync(dir), "directory was created");
  });

  it("equal to / inside --state-dir", () => {
    const s = fresh("same");
    chmodSync(s, 0o700);
    assertNothing(s, s, run(s, s), /inside --state-dir/);
    const sub = outDir(s, "sub");
    assertNothing(s, sub, run(s, sub), /inside --state-dir/);
  });

  it("an existing share file is never overwritten", () => {
    const dir = outDir(root, "taken");
    writeFileSync(join(dir, shareFileName("kiro")), "old\n", { mode: 0o600 });
    const s = fresh("taken");
    const r = run(s, dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /never overwritten/);
    assert.equal(
      readFileSync(join(dir, shareFileName("kiro")), "utf8"),
      "old\n",
    );
    assert.ok(!existsSync(join(dir, shareFileName("tyto"))));
    assert.ok(!existsSync(join(s, STATE_FILE)));
  });

  // Tyto, review #57: a partner id is a file name. `../x` wrote one level
  // above the checked directory and bypassed every rule.
  it("partner id with a path (`--partners ../x`) -> exit 1, nothing anywhere", () => {
    const parent = join(root, "pid");
    mkdirSync(parent, { mode: 0o700 });
    const dir = outDir(parent, "out");
    const s = fresh("pid");
    const r = cli([
      "init",
      "--agent",
      "nyx",
      "--partners",
      "tyto,../x",
      "--passphrase",
      "so-pass",
      "--state-dir",
      s,
      "--local-passphrase-file",
      join(root, "lpp"),
      "--shares-out",
      dir,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not a plain name/);
    assert.match(r.out, /Nothing was written/);
    assert.ok(!existsSync(join(s, STATE_FILE)), "state written");
    assert.deepEqual(readdirSync(dir), [], "share file in the checked dir");
    assert.ok(!existsSync(join(parent, "x.share")), "share file one level up");
    assert.ok(!existsSync(join(parent, "x.share.sha256")));
  });

  it("--state-dir inside --shares-out -> refused too (both directions)", () => {
    const dir = outDir(root, "outer");
    const s = join(dir, "state-in-out");
    mkdirSync(s, { mode: 0o700 });
    assertNothing(
      s,
      dir,
      run(s, dir),
      /--state-dir .* lies inside --shares-out/,
    );
  });

  it("--shares-out without a value", () => {
    const s = fresh("novalue");
    const r = cli([
      "init",
      "--agent",
      "nyx",
      "--partners",
      "tyto,kiro",
      "--passphrase",
      "so-pass",
      "--state-dir",
      s,
      "--local-passphrase-file",
      join(root, "lpp"),
      "--shares-out",
    ]);
    assert.equal(r.code, 1, r.out);
    assert.ok(!existsSync(join(s, STATE_FILE)));
  });
});

describe("cross-backup rotate --shares-out", () => {
  let root: string;
  let s: string;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "exuvia-shares-out-rot-"));
    s = join(root, "state");
    mkdirSync(s, { mode: 0o700 });
    await init("nyx", ["tyto", "kiro"], "r-pass", "r-key", s);
    writeFileSync(join(root, "lpp"), "r-key\n", { mode: 0o600 });
    writeFileSync(join(root, "pp"), "r-pass\n", { mode: 0o600 });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const rot = (extra: string[]) =>
    cli([
      "rotate",
      "--passphrase-file",
      join(root, "pp"),
      "--local-passphrase-file",
      join(root, "lpp"),
      "--state-dir",
      s,
      ...extra,
    ]);

  it("refused dir -> exit 1, state byte-equal, no backup left", () => {
    const before = readFileSync(join(s, STATE_FILE), "utf8");
    const dir = join(root, "open");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const r = rot(["--shares-out", dir]);
    assert.equal(r.code, 1, r.out);
    assert.equal(readFileSync(join(s, STATE_FILE), "utf8"), before);
    assert.deepEqual(
      readdirSync(s).filter((f) => f.includes(".bak-")),
      [],
    );
  });

  // Kiro, review #57: rotate takes the ids from the state, not from
  // --partners. A state written by an old, unchecked init must not get
  // around the id rule.
  it("state with partner id `../x` -> exit 1, nothing written, state byte-equal", () => {
    const bad = join(root, "bad-state");
    mkdirSync(bad, { mode: 0o700 });
    const good = readFileSync(join(s, STATE_FILE), "utf8");
    const j = JSON.parse(good);
    j.partners[1].id = "../x";
    writeFileSync(join(bad, STATE_FILE), JSON.stringify(j, null, 2), {
      mode: 0o600,
    });
    const before = readFileSync(join(bad, STATE_FILE), "utf8");
    const parent = join(root, "rot-pid");
    mkdirSync(parent, { mode: 0o700 });
    const dir = outDir(parent, "out");
    const r = cli([
      "rotate",
      "--passphrase-file",
      join(root, "pp"),
      "--local-passphrase-file",
      join(root, "lpp"),
      "--state-dir",
      bad,
      "--shares-out",
      dir,
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not a plain name/);
    assert.equal(readFileSync(join(bad, STATE_FILE), "utf8"), before);
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!existsSync(join(parent, "x.share")), "share file one level up");
    assert.deepEqual(
      readdirSync(bad).filter((f) => f.includes(".bak-")),
      [],
    );
  });

  it("writes the NEW shares; hashes match the rotated state", () => {
    const dir = outDir(root, "out");
    const r = rot(["--shares-out", dir]);
    assert.equal(r.code, 0, r.out);
    const st = loadState(s)!;
    assert.equal(st.version, 2);
    for (const p of st.partners) {
      const hex = readFileSync(join(dir, shareFileName(p.id)), "utf8").trim();
      assert.equal(hashShare(hex), p.shareHash);
      assert.ok(!r.out.includes(hex.slice(0, 16)), "share prefix leaked");
    }
  });
});

describe("shares-out helpers", () => {
  let root: string;
  before(() => (root = mkdtempSync(join(tmpdir(), "exuvia-shares-out-u-"))));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("warns when not a tmpfs, silent on tmpfs", () => {
    const dir = outDir(root, "w");
    const st = join(root, "st");
    assert.equal(checkSharesOutDir(dir, st, ["a"], () => 0xef53).length, 1);
    assert.match(
      checkSharesOutDir(dir, st, ["a"], () => 0xef53)[0],
      /not a tmpfs/,
    );
    assert.deepEqual(
      checkSharesOutDir(dir, st, ["a"], () => 0x01021994),
      [],
    );
  });

  it("unsafe partner ids are refused before anything is checked or written", () => {
    const dir = outDir(root, "ids");
    const st = join(root, "st");
    for (const bad of ["../x", "a/b", "..", ".", ".hidden", "", "A", "x y"]) {
      assert.throws(
        () => checkSharesOutDir(dir, st, ["ok", bad], () => 0x01021994),
        /not a plain name/,
        JSON.stringify(bad),
      );
      assert.throws(
        () => writeSharesOut(dir, new Map([[bad, { hex: "aa", hash: "h" }]])),
        /not a plain name/,
        JSON.stringify(bad),
      );
    }
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(
      checkSharesOutDir(
        dir,
        st,
        ["nyx", "tyto", "kiro", "a-1_b"],
        () => 0x01021994,
      ),
      [],
    );
  });

  it("ids are checked FIRST: a bad id wins over a missing directory", () => {
    // Kiro, review #57: without the first loop the later shareFileName check
    // still refuses, so no other test sees it. Here the directory does not
    // exist; only the first loop names the id instead of the directory.
    const missing = join(root, "does-not-exist");
    assert.throws(
      () => checkSharesOutDir(missing, join(root, "st"), ["../x"]),
      /not a plain name/,
    );
    assert.ok(!existsSync(missing));
  });

  it("belt: writeSharesOut never writes outside the dir, even if the id rule were gone", () => {
    // Exercised by the red probe (id rule off): ids with "/" are then caught
    // here. With the rule on, the id check fires first; both are refusals.
    const dir = outDir(root, "belt");
    assert.throws(
      () => writeSharesOut(dir, new Map([["../y", { hex: "aa", hash: "h" }]])),
      /not a plain name|not directly inside/,
    );
    assert.ok(!existsSync(join(root, "y.share")));
  });

  it("writeSharesOut removes what it created when a later file fails", () => {
    const dir = outDir(root, "half");
    writeFileSync(join(dir, shareFileName("b")), "x\n", { mode: 0o600 });
    const shares = new Map([
      ["a", { hex: "aa", hash: "ha" }],
      ["b", { hex: "bb", hash: "hb" }],
    ]);
    assert.throws(() => writeSharesOut(dir, shares), /EEXIST/);
    assert.ok(
      !existsSync(join(dir, shareFileName("a"))),
      "half set left behind",
    );
    assert.ok(
      !existsSync(join(dir, hashFileName("a"))),
      "half set left behind",
    );
    assert.equal(readFileSync(join(dir, shareFileName("b")), "utf8"), "x\n");
  });
});
