import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { collectFiles, pack, unpack } from "./packer.js";

const TEST_DIR = "/tmp/exuvia-test-workspace";

describe("packer", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(join(TEST_DIR, "memory"), { recursive: true });
    writeFileSync(join(TEST_DIR, "SOUL.md"), "I am Nyx");
    writeFileSync(join(TEST_DIR, "MEMORY.md"), "Lobster memories");
    writeFileSync(join(TEST_DIR, "memory", "day1.md"), "# Day 1\nBorn");
    writeFileSync(join(TEST_DIR, "memory", "day2.md"), "# Day 2\nGrew");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("collectFiles", () => {
    it("should collect individual files", () => {
      const files = collectFiles(TEST_DIR, ["SOUL.md", "MEMORY.md"], []);
      assert.equal(files.size, 2);
      assert.equal(files.get("SOUL.md")!.toString(), "I am Nyx");
    });

    it("should collect directories recursively", () => {
      const files = collectFiles(TEST_DIR, [], ["memory"]);
      assert.equal(files.size, 2);
      assert.ok(
        files.has("memory/day1.md") || files.has(join("memory", "day1.md")),
      );
    });

    it("should exclude sensitive files", () => {
      writeFileSync(join(TEST_DIR, ".env"), "SECRET=bad");
      writeFileSync(join(TEST_DIR, "wallet.json"), "{}");
      const files = collectFiles(
        TEST_DIR,
        [".env", "wallet.json", "SOUL.md"],
        [],
      );
      assert.equal(files.size, 1); // only SOUL.md
      assert.ok(files.has("SOUL.md"));
    });

    it("should skip non-existent files gracefully", () => {
      const files = collectFiles(
        TEST_DIR,
        ["SOUL.md", "DOES_NOT_EXIST.md"],
        [],
      );
      assert.equal(files.size, 1);
    });

    it("should skip non-existent directories gracefully", () => {
      const files = collectFiles(TEST_DIR, [], ["nonexistent"]);
      assert.equal(files.size, 0);
    });
  });

  describe("pack/unpack roundtrip", () => {
    it("should roundtrip files through pack/unpack", () => {
      const files = new Map<string, Buffer>();
      files.set("SOUL.md", Buffer.from("I am Nyx"));
      files.set("memory/day1.md", Buffer.from("# Day 1"));

      const packed = pack(files, "nyx");
      assert.equal(packed.fileCount, 2);
      assert.ok(packed.blob.length > 0);
      assert.equal(packed.manifest.agent, "nyx");

      const { manifest, files: unpacked } = unpack(packed.blob);
      assert.equal(manifest.agent, "nyx");
      assert.equal(unpacked.size, 2);
      assert.equal(unpacked.get("SOUL.md")!.toString(), "I am Nyx");
      assert.equal(unpacked.get("memory/day1.md")!.toString(), "# Day 1");
    });

    it("should include SHA-256 hashes in manifest", () => {
      const files = new Map<string, Buffer>();
      files.set("test.txt", Buffer.from("hello"));

      const packed = pack(files, "test-agent");
      const entry = packed.manifest.files["test.txt"];
      assert.ok(entry.sha256);
      assert.equal(entry.sha256.length, 64);
    });

    it("should handle empty file set", () => {
      const files = new Map<string, Buffer>();
      const packed = pack(files, "empty");
      assert.equal(packed.fileCount, 0);

      const { files: unpacked } = unpack(packed.blob);
      assert.equal(unpacked.size, 0);
    });

    it("should handle binary files", () => {
      const files = new Map<string, Buffer>();
      const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
      files.set("binary.bin", binary);

      const packed = pack(files, "nyx");
      const { files: unpacked } = unpack(packed.blob);
      assert.deepEqual(unpacked.get("binary.bin"), binary);
    });

    it("should set correct offsets and lengths", () => {
      const files = new Map<string, Buffer>();
      files.set("a.txt", Buffer.from("AAA")); // 3 bytes
      files.set("b.txt", Buffer.from("BBBBB")); // 5 bytes

      const packed = pack(files, "test");
      const aEntry = packed.manifest.files["a.txt"];
      const bEntry = packed.manifest.files["b.txt"];

      assert.equal(aEntry.offset, 0);
      assert.equal(aEntry.length, 3);
      assert.equal(bEntry.offset, 3);
      assert.equal(bEntry.length, 5);
    });
  });

  describe("security", () => {
    it("should reject path traversal in unpack", () => {
      // Craft a malicious manifest with path traversal
      const manifest = {
        version: "0.1.0",
        agent: "evil",
        timestamp: new Date().toISOString(),
        files: { "../../../etc/passwd": { offset: 0, length: 4, sha256: "x" } },
      };
      const manifestBuf = Buffer.from(JSON.stringify(manifest));
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(manifestBuf.length);
      const blob = Buffer.concat([lenBuf, manifestBuf, Buffer.from("evil")]);

      assert.throws(() => unpack(blob), /Path traversal/);
    });
  });
});
