/**
 * Cross-Backup Tests
 *
 * Tests for mutual identity insurance between agents.
 * Covers: init, receive, verify, status, encryption, rotation.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  init,
  receiveShare,
  verifyShare,
  status,
  encryptShare,
  decryptShare,
  hashShare,
  loadState,
  verifyStateDecrypts,
} from "./cross-backup.js";

describe("cross-backup — share encryption", () => {
  const passphrase = "test-passphrase-2026";
  const shareHex = "abcdef0123456789abcdef0123456789";

  it("should encrypt and decrypt a share", () => {
    const encrypted = encryptShare(shareHex, passphrase);
    const decrypted = decryptShare(encrypted, passphrase);
    assert.equal(decrypted, shareHex);
  });

  it("should produce different ciphertext each time (random salt/iv)", () => {
    const e1 = encryptShare(shareHex, passphrase);
    const e2 = encryptShare(shareHex, passphrase);
    assert.notEqual(e1, e2); // Different salt + IV
  });

  it("should fail decryption with wrong passphrase", () => {
    const encrypted = encryptShare(shareHex, passphrase);
    assert.throws(() => decryptShare(encrypted, "wrong-passphrase"));
  });

  it("should fail on tampered ciphertext", () => {
    const encrypted = encryptShare(shareHex, passphrase);
    // Flip a byte in the middle
    const buf = Buffer.from(encrypted, "hex");
    buf[50] ^= 0xff;
    assert.throws(() => decryptShare(buf.toString("hex"), passphrase));
  });
});

describe("cross-backup — hashShare", () => {
  it("should return consistent SHA-256 hash", () => {
    const h1 = hashShare("abcdef");
    const h2 = hashShare("abcdef");
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // 32 bytes as hex
  });

  it("should differ for different shares", () => {
    const h1 = hashShare("share1");
    const h2 = hashShare("share2");
    assert.notEqual(h1, h2);
  });
});

describe("cross-backup — init", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "exuvia-cb-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should create state with 2-of-3 threshold for 3 agents", async () => {
    const result = await init(
      "nyx",
      ["tyto", "kiro"],
      "my-secret-passphrase",
      "local-encryption-key",
      tmpDir,
    );

    assert.equal(result.state.agentId, "nyx");
    assert.equal(result.state.threshold, 2);
    assert.equal(result.state.total, 3);
    assert.equal(result.state.version, 1);
    assert.equal(result.state.partners.length, 2);
    assert.equal(result.sharesToSend.size, 2);
    assert.ok(result.sharesToSend.has("tyto"));
    assert.ok(result.sharesToSend.has("kiro"));
  });

  it("should save state file to disk", async () => {
    await init("nyx", ["tyto", "kiro"], "pass", "local", tmpDir);
    const state = loadState(tmpDir);
    assert.ok(state);
    assert.equal(state!.agentId, "nyx");
  });

  it("should encrypt local share", async () => {
    const result = await init(
      "nyx",
      ["tyto", "kiro"],
      "pass",
      "local-key",
      tmpDir,
    );
    // Local share should be encrypted (not plaintext)
    assert.ok(result.state.localShareHex.length > 100); // encrypted = much longer
    // Should be decryptable
    const decrypted = decryptShare(result.state.localShareHex, "local-key");
    assert.equal(hashShare(decrypted), result.state.localShareHash);
  });

  it("should provide share hashes for verification (Kiro F1)", async () => {
    const result = await init("nyx", ["tyto", "kiro"], "pass", "key", tmpDir);
    for (const [, { hex, hash }] of result.sharesToSend) {
      assert.equal(hashShare(hex), hash);
    }
  });

  it("should encrypt partner shares in state", async () => {
    const result = await init("nyx", ["tyto", "kiro"], "pass", "key", tmpDir);
    for (const partner of result.state.partners) {
      // Partner shares in state are encrypted
      assert.ok(partner.shareHex.length > 100);
      // But we can still decrypt them with our key
      const decrypted = decryptShare(partner.shareHex, "key");
      assert.equal(hashShare(decrypted), partner.shareHash);
    }
  });
});

describe("cross-backup — receiveShare", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "exuvia-cb-recv-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should store a verified share", () => {
    const shareHex = "deadbeef1234567890";
    const hash = hashShare(shareHex);
    const result = receiveShare(
      "tyto",
      shareHex,
      hash,
      "my-key",
      undefined,
      tmpDir,
    );
    assert.equal(result.verified, true);
    assert.equal(result.stored, true);

    // Check file exists
    const path = join(tmpDir, ".exuvia-received-shares.json");
    assert.ok(existsSync(path));
  });

  it("should reject share with wrong hash (Kiro F1)", () => {
    const result = receiveShare(
      "kiro",
      "abcdef",
      "wrong-hash",
      "key",
      undefined,
      tmpDir,
    );
    assert.equal(result.verified, false);
    assert.equal(result.stored, false);
  });

  it("should increment version on re-receive", () => {
    const shareHex = "cafebabe";
    const hash = hashShare(shareHex);
    receiveShare("nyx", shareHex, hash, "key", undefined, tmpDir);
    receiveShare("nyx", shareHex, hash, "key", undefined, tmpDir);

    const path = join(tmpDir, ".exuvia-received-shares.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data["nyx"].version, 2);
  });

  it("should store arweave tx ID", () => {
    const shareHex = "feedface";
    const hash = hashShare(shareHex);
    receiveShare("tyto", shareHex, hash, "key", "tx_abc123", tmpDir);

    const path = join(tmpDir, ".exuvia-received-shares.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data["tyto"].arweaveTxId, "tx_abc123");
  });
});

describe("cross-backup — verifyShare", () => {
  it("should return true for matching hash", () => {
    const hex = "test-share-data";
    assert.ok(verifyShare(hex, hashShare(hex)));
  });

  it("should return false for mismatched hash", () => {
    assert.ok(!verifyShare("data", "wrong-hash"));
  });
});

describe("cross-backup — status", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "exuvia-cb-status-"));
    await init("nyx", ["tyto", "kiro"], "pass", "status-key", tmpDir);
    // Also receive a share from tyto
    const shareHex = "tyto-share-for-nyx";
    receiveShare(
      "tyto",
      shareHex,
      hashShare(shareHex),
      "status-key",
      "tx_tyto",
      tmpDir,
    );
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should return full status", () => {
    const s = status("status-key", tmpDir);
    assert.ok(s);
    assert.equal(s!.agentId, "nyx");
    assert.equal(s!.threshold, 2);
    assert.equal(s!.total, 3);
    assert.equal(s!.localShareOk, true);
    assert.equal(s!.partners.length, 2);
    assert.equal(s!.receivedShares.length, 1);
    assert.equal(s!.receivedShares[0].fromId, "tyto");
  });

  it("should detect wrong passphrase", () => {
    const s = status("wrong-key", tmpDir);
    assert.ok(s);
    assert.equal(s!.localShareOk, false);
  });

  it("should return null when no state", () => {
    const s = status("key", "/tmp/nonexistent-cb-dir");
    assert.equal(s, null);
  });
});

describe("cross-backup — full cycle (init → distribute → receive → reconstruct)", () => {
  let tmpNyx: string;
  let tmpTyto: string;
  let tmpKiro: string;

  before(() => {
    tmpNyx = mkdtempSync(join(tmpdir(), "exuvia-nyx-"));
    tmpTyto = mkdtempSync(join(tmpdir(), "exuvia-tyto-"));
    tmpKiro = mkdtempSync(join(tmpdir(), "exuvia-kiro-"));
  });

  after(() => {
    rmSync(tmpNyx, { recursive: true, force: true });
    rmSync(tmpTyto, { recursive: true, force: true });
    rmSync(tmpKiro, { recursive: true, force: true });
  });

  it("should enable 2-of-3 recovery of Nyx's passphrase", async () => {
    const SECRET = "KosmischerLobster!2026";

    // 1. Nyx inits cross-backup
    const nyxResult = await init(
      "nyx",
      ["tyto", "kiro"],
      SECRET,
      "nyx-local",
      tmpNyx,
    );

    // 2. Nyx distributes shares to Tyto and Kiro
    const tytoShare = nyxResult.sharesToSend.get("tyto")!;
    const kiroShare = nyxResult.sharesToSend.get("kiro")!;

    // 3. Tyto receives her share
    const tytoRecv = receiveShare(
      "nyx",
      tytoShare.hex,
      tytoShare.hash,
      "tyto-local",
      undefined,
      tmpTyto,
    );
    assert.ok(tytoRecv.verified);

    // 4. Kiro receives his share
    const kiroRecv = receiveShare(
      "nyx",
      kiroShare.hex,
      kiroShare.hash,
      "kiro-local",
      undefined,
      tmpKiro,
    );
    assert.ok(kiroRecv.verified);

    // 5. RECOVERY: Nyx goes down. Tyto + Kiro reconstruct.
    //    They need to decrypt their stored shares first.
    const tytoStored = JSON.parse(
      readFileSync(join(tmpTyto, ".exuvia-received-shares.json"), "utf8"),
    );
    const kiroStored = JSON.parse(
      readFileSync(join(tmpKiro, ".exuvia-received-shares.json"), "utf8"),
    );

    const tytoDecrypted = decryptShare(
      tytoStored["nyx"].shareHex,
      "tyto-local",
    );
    const kiroDecrypted = decryptShare(
      kiroStored["nyx"].shareHex,
      "kiro-local",
    );

    // 6. Combine shares (2-of-3 threshold)
    const { combineShares: combine } = await import("./shamir.js");
    const { hexToShare } = await import("./shamir.js");

    const recovered = await combine([
      hexToShare(tytoDecrypted),
      hexToShare(kiroDecrypted),
    ]);

    assert.equal(recovered, SECRET);
  });
});

describe("cross-backup — rotate", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "exuvia-rotate-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should re-split and bump version", async () => {
    const { rotate } = await import("./cross-backup.js");

    // Init first
    const result = await init(
      "nyx",
      ["tyto", "kiro"],
      "MySecret!2026",
      "local-key",
      tmpDir,
    );
    assert.equal(result.state.version, 1);

    // Rotate
    const rotated = await rotate("MySecret!2026", "local-key", tmpDir);
    assert.equal(rotated.newVersion, 2);
    assert.ok(rotated.sharesToSend.has("tyto"));
    assert.ok(rotated.sharesToSend.has("kiro"));

    // State persisted with new version
    const s = loadState(tmpDir)!;
    assert.equal(s.version, 2);
    assert.equal(s.partners[0].version, 2);
    assert.equal(s.partners[1].version, 2);
  });

  it("should generate different shares on rotation", async () => {
    const { rotate } = await import("./cross-backup.js");
    const tmpDir2 = mkdtempSync(join(tmpdir(), "exuvia-rot2-"));

    await init("nyx", ["tyto", "kiro"], "Secret", "key", tmpDir2);
    const state1 = loadState(tmpDir2)!;
    const hash1 = state1.localShareHash;

    await rotate("Secret", "key", tmpDir2);
    const state2 = loadState(tmpDir2)!;
    const hash2 = state2.localShareHash;

    // New shares should differ (randomness in Shamir split)
    assert.notEqual(hash1, hash2);

    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("should throw if no state exists", async () => {
    const { rotate } = await import("./cross-backup.js");
    await assert.rejects(
      () => rotate("secret", "key", "/tmp/nonexistent-rotate-dir"),
      /No cross-backup state found/,
    );
  });

  it("should produce recoverable shares after rotation", async () => {
    const { rotate } = await import("./cross-backup.js");
    const { combineShares: combine, hexToShare: h2s } =
      await import("./shamir.js");
    const tmpDir3 = mkdtempSync(join(tmpdir(), "exuvia-rot3-"));

    const SECRET = "RotateRecoverTest!";
    await init("nyx", ["tyto", "kiro"], SECRET, "key", tmpDir3);

    // Rotate
    const rotated = await rotate(SECRET, "key", tmpDir3);
    const tytoShare = rotated.sharesToSend.get("tyto")!;
    const kiroShare = rotated.sharesToSend.get("kiro")!;

    // Recover with new shares
    const recovered = await combine([h2s(tytoShare.hex), h2s(kiroShare.hex)]);
    assert.equal(recovered, SECRET);

    rmSync(tmpDir3, { recursive: true, force: true });
  });
});

describe("cross-backup — recover", () => {
  let tmpCoordinator: string;
  let tmpHelper: string;

  before(() => {
    tmpCoordinator = mkdtempSync(join(tmpdir(), "exuvia-coord-"));
    tmpHelper = mkdtempSync(join(tmpdir(), "exuvia-helper-"));
  });

  after(() => {
    rmSync(tmpCoordinator, { recursive: true, force: true });
    rmSync(tmpHelper, { recursive: true, force: true });
  });

  it("should recover passphrase using recover()", async () => {
    const { recover } = await import("./cross-backup.js");

    const SECRET = "RecoverTest!2026";

    // Nyx inits and distributes
    const nyxDir = mkdtempSync(join(tmpdir(), "exuvia-nyx-rec-"));
    const nyxResult = await init(
      "nyx",
      ["tyto", "kiro"],
      SECRET,
      "nyx-key",
      nyxDir,
    );

    const tytoShare = nyxResult.sharesToSend.get("tyto")!;
    const kiroShare = nyxResult.sharesToSend.get("kiro")!;

    // Tyto (coordinator) receives
    receiveShare(
      "nyx",
      tytoShare.hex,
      tytoShare.hash,
      "tyto-key",
      undefined,
      tmpCoordinator,
    );

    // Kiro (helper) sends plaintext share to Tyto
    // In real life: Kiro decrypts their share and sends it securely
    const result = await recover(
      "nyx",
      "tyto-key",
      [kiroShare.hex],
      tmpCoordinator,
    );

    assert.equal(result.passphrase, SECRET);
    assert.equal(result.agentId, "nyx");
    assert.equal(result.sharesUsed, 2);

    rmSync(nyxDir, { recursive: true, force: true });
  });

  it("should throw with wrong passphrase", async () => {
    const { recover } = await import("./cross-backup.js");

    const nyxDir = mkdtempSync(join(tmpdir(), "exuvia-nyx-rec2-"));
    const nyxResult = await init("nyx", ["tyto"], "Secret", "nyx-key", nyxDir);

    const tytoShare = nyxResult.sharesToSend.get("tyto")!;
    receiveShare(
      "nyx",
      tytoShare.hex,
      tytoShare.hash,
      "tyto-key",
      undefined,
      tmpCoordinator,
    );

    await assert.rejects(
      () => recover("nyx", "WRONG-key", [], tmpCoordinator),
      /Failed to decrypt/,
    );

    rmSync(nyxDir, { recursive: true, force: true });
  });

  it("should throw when no share for agent", async () => {
    const { recover } = await import("./cross-backup.js");

    await assert.rejects(
      () => recover("unknown-agent", "key", [], tmpCoordinator),
      /No share stored for agent/,
    );
  });

  it("should throw when no received shares file", async () => {
    const { recover } = await import("./cross-backup.js");

    await assert.rejects(
      () => recover("nyx", "key", [], "/tmp/nonexistent-recover-dir"),
      /No received shares found/,
    );
  });
});

describe("cross-backup — loadState schema guard", () => {
  it("should reject a hand-written holder ledger instead of crashing later", () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-schema-"));
    try {
      // Shape of a real hand-written file (03.07.2026): holders[] instead of partners[]
      writeFileSync(
        join(dir, ".exuvia-cross-backup.json"),
        JSON.stringify({
          agentId: "nyx",
          version: 3,
          threshold: 3,
          total: 5,
          localShareHex: "ab",
          localShareHash: "cd",
          holders: [{ id: "tyto", shareIndex: 4 }],
        }),
      );
      assert.throws(() => loadState(dir), /missing\/invalid partners/);
      assert.throws(() => status("x", dir), /not a valid cross-backup state/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should reject partners[] that is an array of the wrong things", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-schema-partners-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir);
      const file = join(dir, ".exuvia-cross-backup.json");
      const good = JSON.parse(readFileSync(file, "utf8"));
      // Array present, entries wrong: holder-ledger style ids, missing share data
      good.partners = [{ id: "tyto", shareIndex: "4" }, "kiro"];
      writeFileSync(file, JSON.stringify(good));
      assert.throws(
        () => loadState(dir),
        /partners\[0\]\.shareIndex \(expected number\)/,
      );
      assert.throws(() => loadState(dir), /partners\[0\]\.shareHex/);
      assert.throws(() => loadState(dir), /partners\[1\] \(expected object\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should still load a state written by init()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-schema-ok-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir);
      const s = loadState(dir);
      assert.ok(s);
      assert.ok(Array.isArray(s.partners));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cross-backup — init reads the local passphrase back from storage", () => {
  it("passes when the stored passphrase matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-kept-ok-"));
    const file = join(dir, "lpp.txt");
    try {
      writeFileSync(file, "pp-local\n");
      await init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir, () =>
        readFileSync(file, "utf8"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the passphrase was NEVER stored (the May 2026 case)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-kept-missing-"));
    const file = join(dir, "lpp.txt"); // deliberately not written
    try {
      await assert.rejects(
        init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir, () =>
          readFileSync(file, "utf8"),
        ),
        /could not be read back/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when an empty passphrase was stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-kept-empty-"));
    try {
      await assert.rejects(
        init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir, () => "  \n"),
        /could not be read back/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a DIFFERENT passphrase was stored than the one used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-kept-diff-"));
    try {
      await assert.rejects(
        init(
          "nyx",
          ["tyto", "kiro"],
          "pp-main",
          "pp-local",
          dir,
          () => "pp-typo",
        ),
        /cannot be decrypted/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cross-backup — round-trip decrypt check", () => {
  it("accepts a state written by init() with the same passphrase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-rt-ok-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir);
      assert.doesNotThrow(() =>
        verifyStateDecrypts(loadState(dir)!, "pp-local"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects the wrong local passphrase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-rt-wrong-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir);
      assert.throws(
        () => verifyStateDecrypts(loadState(dir)!, "pp-other"),
        /local share: cannot be decrypted/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a share stored as plaintext (structure looks fine)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-rt-plain-"));
    try {
      await init("nyx", ["tyto", "kiro"], "pp-main", "pp-local", dir);
      const s = loadState(dir)!;
      const plain = decryptShare(s.partners[1].shareHex, "pp-local");
      s.partners[1].shareHex = plain; // valid structure, hash matches plaintext, but not encrypted
      assert.throws(
        () => verifyStateDecrypts(s, "pp-local"),
        /share for kiro: cannot be decrypted/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a share whose hash was tampered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xb-rt-hash-"));
    try {
      await init("nyx", ["tyto"], "pp-main", "pp-local", dir);
      const s = loadState(dir)!;
      s.localShareHash = "0".repeat(64);
      assert.throws(
        () => verifyStateDecrypts(s, "pp-local"),
        /hash does not match/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
