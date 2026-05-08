/**
 * Cross-Backup Tests
 *
 * Tests for mutual identity insurance between agents.
 * Covers: init, receive, verify, status, encryption, rotation.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
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
