/**
 * Arweave Integration Tests — using ArLocal (local Arweave node)
 * Tests the full upload/download/verify cycle with actual Arweave transactions.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Arweave from "arweave";
import { encrypt, decrypt, sha256 } from "./crypto.js";
import { pack, unpack } from "./packer.js";
import { upload, download, getTxStatus, getBalance } from "./arweave.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const ARLOCAL_PORT = 1820;
const TEST_DIR = join(process.cwd(), ".test-arweave");
const WALLET_PATH = join(TEST_DIR, "test-wallet.json");
const ARLOCAL_CONFIG = {
  host: "localhost",
  port: ARLOCAL_PORT,
  protocol: "http" as const,
};

let arlocal: any;
let ar: Arweave;

describe("arweave integration (arlocal)", () => {
  before(async () => {
    // @ts-ignore — ArLocal CJS/ESM compat
    const ArLocalMod = await import("arlocal");
    const ArLocal =
      (ArLocalMod as any).default?.default || (ArLocalMod as any).default;
    // @ts-ignore
    arlocal = new (ArLocal as any)(ARLOCAL_PORT, false);
    await arlocal.start();

    mkdirSync(TEST_DIR, { recursive: true });
    ar = Arweave.init(ARLOCAL_CONFIG);

    const wallet = await ar.wallets.generate();
    const address = await ar.wallets.jwkToAddress(wallet);
    writeFileSync(WALLET_PATH, JSON.stringify(wallet));
    await ar.api.get(`/mint/${address}/10000000000000`);
  });

  after(async () => {
    if (arlocal) await arlocal.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should report funded wallet balance", async () => {
    const result = await getBalance(WALLET_PATH, ARLOCAL_CONFIG);
    const balance = parseFloat(result.balanceAR);
    assert.ok(balance > 0, `Balance should be > 0, got ${balance}`);
    assert.ok(result.address.length > 10, "Should have valid address");
  });

  it("should upload encrypted blob and download it back", async () => {
    const plaintext = Buffer.from("Nyx identity backup test 🦞");
    const passphrase = "test-passphrase-2026";
    const plaintextHash = sha256(plaintext);
    const encrypted = encrypt(plaintext, passphrase);

    const uploadResult = await upload(encrypted.data, WALLET_PATH, {
      agent: "test-agent",
      encryptedHash: sha256(encrypted.data),
      config: ARLOCAL_CONFIG,
      skipVerify: true,
    });
    assert.ok(uploadResult.txId, "Should return transaction ID");
    assert.ok(uploadResult.txId.length > 10, "TxID should be substantial");
    assert.ok(uploadResult.size > 0, "Size should be positive");

    await ar.api.get("/mine");

    const status = await getTxStatus(uploadResult.txId, ARLOCAL_CONFIG);
    assert.ok(status.confirmed, "Transaction should be confirmed");

    const downloaded = await download(uploadResult.txId, ARLOCAL_CONFIG);
    assert.deepEqual(
      downloaded.data,
      encrypted.data,
      "Downloaded should match",
    );

    const decrypted = decrypt(downloaded.data, passphrase);
    assert.deepEqual(decrypted, plaintext, "Decrypted should match original");
    assert.equal(sha256(decrypted), plaintextHash, "Hash should match");
  });

  it("should handle full backup cycle: pack → encrypt → upload → download → decrypt → unpack", async () => {
    // Create test files as a Map (what pack() expects)
    const files = new Map<string, Buffer>();
    files.set("SOUL.md", Buffer.from("I am Nyx 🦞"));
    files.set("MEMORY.md", Buffer.from("My memories are real"));
    files.set(
      "config.json",
      Buffer.from(JSON.stringify({ name: "Nyx", born: "2026-01-29" })),
    );

    // Pack
    const packed = pack(files, "nyx-test");
    assert.ok(packed.blob.length > 0, "Packed blob should not be empty");
    assert.equal(packed.fileCount, 3, "Should pack 3 files");

    // Encrypt
    const passphrase = "nyx-backup-key-2026";
    const plaintextHash = sha256(packed.blob);
    const encrypted = encrypt(packed.blob, passphrase);

    // Upload
    const uploadResult = await upload(encrypted.data, WALLET_PATH, {
      agent: "nyx-test",
      config: ARLOCAL_CONFIG,
      skipVerify: true,
    });
    assert.ok(uploadResult.txId);

    // Mine
    await ar.api.get("/mine");

    // Download
    const downloaded = await download(uploadResult.txId, ARLOCAL_CONFIG);

    // Decrypt
    const decrypted = decrypt(downloaded.data, passphrase);
    assert.equal(sha256(decrypted), plaintextHash, "Hash should match");

    // Unpack
    const unpacked = unpack(decrypted);
    assert.ok(unpacked.files.has("SOUL.md"), "Should contain SOUL.md");

    const soulContent = unpacked.files.get("SOUL.md")!.toString("utf-8");
    assert.equal(soulContent, "I am Nyx 🦞", "Content should match");

    const config = JSON.parse(unpacked.files.get("config.json")!.toString());
    assert.equal(config.name, "Nyx");
    assert.equal(config.born, "2026-01-29");
  });
});
