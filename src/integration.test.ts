import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { collectFiles, pack, unpack } from "./packer.js";
import { encrypt, decrypt, sha256 } from "./crypto.js";
import {
  splitPassphrase,
  combineShares,
  shareToHex,
  hexToShare,
} from "./shamir.js";

const TEST_DIR = "/tmp/exuvia-integration-test";

describe("integration: full backup/restore cycle", () => {
  const passphrase = "KosmischerLobster!2026";

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "memory"), { recursive: true });
    writeFileSync(join(TEST_DIR, "SOUL.md"), "# Nyx\nI am a cosmic lobster.");
    writeFileSync(
      join(TEST_DIR, "MEMORY.md"),
      "# Memories\nFabian sang Happy Birthday.",
    );
    writeFileSync(
      join(TEST_DIR, "IDENTITY.md"),
      "# Identity\nName: Nyx\nCreature: Lobster",
    );
    writeFileSync(
      join(TEST_DIR, "memory", "day1.md"),
      "# 2026-01-29\nBorn today.",
    );
    writeFileSync(
      join(TEST_DIR, "memory", "day2.md"),
      "# 2026-01-30\nFirst autonomous decision.",
    );
    writeFileSync(join(TEST_DIR, ".env"), "SECRET=never_include_this");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should backup and restore identity completely", () => {
    const files = collectFiles(
      TEST_DIR,
      ["SOUL.md", "MEMORY.md", "IDENTITY.md", ".env"],
      ["memory"],
    );
    assert.equal(files.size, 5);
    assert.ok(!files.has(".env"), ".env must be excluded by DEFAULT_EXCLUDES");

    const packed = pack(files, "nyx");
    assert.equal(packed.fileCount, 5);

    const encrypted = encrypt(packed.blob, passphrase);
    assert.ok(encrypted.data.length > packed.blob.length);

    const decrypted = decrypt(encrypted.data, passphrase, encrypted.hash);
    assert.deepEqual(decrypted, packed.blob);

    const { manifest, files: restored } = unpack(decrypted);
    assert.equal(manifest.agent, "nyx");
    assert.equal(restored.size, 5);
    assert.equal(
      restored.get("SOUL.md")!.toString(),
      "# Nyx\nI am a cosmic lobster.",
    );
    assert.equal(
      restored.get("IDENTITY.md")!.toString(),
      "# Identity\nName: Nyx\nCreature: Lobster",
    );
    assert.ok(
      !restored.has(".env"),
      ".env must not survive backup/restore cycle",
    );
  });

  it("should work with 3-of-5 Shamir key recovery", async () => {
    // Step 1: Backup
    const files = collectFiles(TEST_DIR, ["SOUL.md"], []);
    const packed = pack(files, "nyx");
    const encrypted = encrypt(packed.blob, passphrase);

    // Step 2: Split passphrase into 5 shares (3-of-5)
    const shares = await splitPassphrase(passphrase);

    // Step 3: Simulate: DE is gone (fabian+alex lost), only kiro+tyto+arweave
    const kiroHex = shareToHex(shares.shares[2]);
    const tytoHex = shareToHex(shares.shares[3]);
    const arweaveHex = shareToHex(shares.shares[4]);

    // Step 4: Recover passphrase with 3 shares
    const recoveredPassphrase = await combineShares([
      hexToShare(kiroHex),
      hexToShare(tytoHex),
      hexToShare(arweaveHex),
    ]);
    assert.equal(recoveredPassphrase, passphrase);

    // Step 5: Decrypt and restore
    const decrypted = decrypt(
      encrypted.data,
      recoveredPassphrase,
      encrypted.hash,
    );
    const { files: restored } = unpack(decrypted);
    assert.equal(
      restored.get("SOUL.md")!.toString(),
      "# Nyx\nI am a cosmic lobster.",
    );
  });

  it("should work with human-only recovery (fabian+alex+arweave)", async () => {
    const files = collectFiles(TEST_DIR, ["SOUL.md"], []);
    const packed = pack(files, "nyx");
    const encrypted = encrypt(packed.blob, passphrase);

    const shares = await splitPassphrase(passphrase);

    // All AIs down — only humans + arweave
    const fabianHex = shareToHex(shares.shares[0]);
    const alexHex = shareToHex(shares.shares[1]);
    const arweaveHex = shareToHex(shares.shares[4]);

    const recoveredPassphrase = await combineShares([
      hexToShare(fabianHex),
      hexToShare(alexHex),
      hexToShare(arweaveHex),
    ]);
    assert.equal(recoveredPassphrase, passphrase);

    const decrypted = decrypt(
      encrypted.data,
      recoveredPassphrase,
      encrypted.hash,
    );
    const { files: restored } = unpack(decrypted);
    assert.equal(
      restored.get("SOUL.md")!.toString(),
      "# Nyx\nI am a cosmic lobster.",
    );
  });

  it("should verify hash without decrypting", () => {
    const files = collectFiles(TEST_DIR, ["SOUL.md"], []);
    const packed = pack(files, "nyx");
    const encrypted = encrypt(packed.blob, passphrase);

    const plaintextHash = sha256(packed.blob);
    assert.equal(plaintextHash, encrypted.hash);
  });
});
