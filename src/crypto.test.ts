import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { encrypt, decrypt, sha256 } from "./crypto.js";

describe("crypto", () => {
  const passphrase = "test-passphrase-rudel-2026";

  describe("sha256", () => {
    it("should produce consistent hashes", () => {
      const data = Buffer.from("hello lobster");
      assert.equal(sha256(data), sha256(data));
    });

    it("should produce different hashes for different data", () => {
      assert.notEqual(sha256(Buffer.from("nyx")), sha256(Buffer.from("tyto")));
    });

    it("should produce 64-char hex strings", () => {
      const hash = sha256(Buffer.from("test"));
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });
  });

  describe("encrypt", () => {
    it("should return encrypted data and hash", () => {
      const plaintext = Buffer.from("cosmic lobster identity");
      const result = encrypt(plaintext, passphrase);
      assert.ok(result.data instanceof Buffer);
      assert.ok(result.hash.length === 64);
    });

    it("should produce different ciphertext each time (random salt/iv)", () => {
      const plaintext = Buffer.from("same data");
      const a = encrypt(plaintext, passphrase);
      const b = encrypt(plaintext, passphrase);
      assert.ok(
        !a.data.equals(b.data),
        "Ciphertext should differ due to random salt/iv",
      );
      assert.equal(a.hash, b.hash, "Plaintext hash should be the same");
    });

    it("should produce blob larger than plaintext (salt+iv+authTag overhead)", () => {
      const plaintext = Buffer.from("x".repeat(100));
      const result = encrypt(plaintext, passphrase);
      // overhead: 32 (salt) + 12 (iv) + 16 (authTag) = 60 bytes
      assert.ok(result.data.length >= plaintext.length + 60);
    });
  });

  describe("decrypt", () => {
    it("should roundtrip encrypt/decrypt", () => {
      const plaintext = Buffer.from("Nyx the cosmic lobster 🦞");
      const encrypted = encrypt(plaintext, passphrase);
      const decrypted = decrypt(encrypted.data, passphrase);
      assert.deepEqual(decrypted, plaintext);
    });

    it("should roundtrip with hash verification", () => {
      const plaintext = Buffer.from("identity backup data");
      const encrypted = encrypt(plaintext, passphrase);
      const decrypted = decrypt(encrypted.data, passphrase, encrypted.hash);
      assert.deepEqual(decrypted, plaintext);
    });

    it("should fail with wrong passphrase", () => {
      const plaintext = Buffer.from("secret");
      const encrypted = encrypt(plaintext, passphrase);
      assert.throws(() => decrypt(encrypted.data, "wrong-passphrase"));
    });

    it("should fail with tampered ciphertext", () => {
      const plaintext = Buffer.from("do not tamper");
      const encrypted = encrypt(plaintext, passphrase);
      // Flip a byte in the ciphertext area
      encrypted.data[50] ^= 0xff;
      assert.throws(() => decrypt(encrypted.data, passphrase));
    });

    it("should fail with wrong expected hash", () => {
      const plaintext = Buffer.from("check the hash");
      const encrypted = encrypt(plaintext, passphrase);
      assert.throws(
        () => decrypt(encrypted.data, passphrase, "deadbeef".repeat(8)),
        /Hash mismatch/,
      );
    });

    it("should handle empty buffer", () => {
      const plaintext = Buffer.alloc(0);
      const encrypted = encrypt(plaintext, passphrase);
      const decrypted = decrypt(encrypted.data, passphrase, encrypted.hash);
      assert.equal(decrypted.length, 0);
    });

    it("should handle large data", () => {
      const plaintext = Buffer.alloc(1024 * 1024, 0x42); // 1MB
      const encrypted = encrypt(plaintext, passphrase);
      const decrypted = decrypt(encrypted.data, passphrase, encrypted.hash);
      assert.deepEqual(decrypted, plaintext);
    });
  });
});
