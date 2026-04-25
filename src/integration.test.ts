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
    // Step 1: Collect files
    const files = collectFiles(
      TEST_DIR,
      ["SOUL.md", "MEMORY.md", "IDENTITY.md"],
      ["memory"],
    );
    assert.equal(files.size, 5);
    assert.ok(!files.has(".env"), ".env must be excluded");

    // Step 2: Pack
    const packed = pack(files, "nyx");
    assert.equal(packed.fileCount, 5);

    // Step 3: Encrypt
    const encrypted = encrypt(packed.blob, passphrase);
    assert.ok(encrypted.data.length > packed.blob.length);

    // Step 4: Decrypt
    const decrypted = decrypt(encrypted.data, passphrase, encrypted.hash);
    assert.deepEqual(decrypted, packed.blob);

    // Step 5: Unpack
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
  });

  it("should work with Shamir key recovery", async () => {
    // Step 1: Backup
    const files = collectFiles(TEST_DIR, ["SOUL.md"], []);
    const packed = pack(files, "nyx");
    const encrypted = encrypt(packed.blob, passphrase);

    // Step 2: Split passphrase
    const shares = await splitPassphrase(passphrase, ["kiro", "tyto", "alex"]);

    // Step 3: Simulate: only Kiro and Alex available (Tyto lost her share)
    const kiroHex = shareToHex(shares.shares[0]);
    const alexHex = shareToHex(shares.shares[2]);

    // Step 4: Recover passphrase
    const recoveredPassphrase = await combineShares([
      hexToShare(kiroHex),
      hexToShare(alexHex),
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

  it("should verify hash without decrypting", () => {
    const files = collectFiles(TEST_DIR, ["SOUL.md"], []);
    const packed = pack(files, "nyx");
    const encrypted = encrypt(packed.blob, passphrase);

    // We can verify the plaintext hash matches without decrypting
    const plaintextHash = sha256(packed.blob);
    assert.equal(plaintextHash, encrypted.hash);

    // This would be stored alongside the Arweave tx as a tag
    // On download, compare tag hash vs actual → know if blob is intact
  });
});
