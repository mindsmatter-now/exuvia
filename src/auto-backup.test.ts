import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runBackup } from "./auto-backup.js";

const TEST_DIR = join(process.cwd(), ".test-auto-backup");
const SOURCE_DIR = join(TEST_DIR, "source");
const LOG_FILE = join(TEST_DIR, "backup.log");

describe("auto-backup", () => {
  before(() => {
    mkdirSync(SOURCE_DIR, { recursive: true });
    writeFileSync(join(SOURCE_DIR, "identity.md"), "# I am Nyx");
    writeFileSync(join(SOURCE_DIR, "memory.json"), '{"lobster": true}');
    writeFileSync(join(SOURCE_DIR, "soul.txt"), "cosmic lobster energy");
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("dry run: packs + encrypts without uploading", async () => {
    const result = await runBackup({
      source: SOURCE_DIR,
      passphrase: "test-passphrase-2026",
      walletPath: "/nonexistent/wallet.json",
      dryRun: true,
      logFile: LOG_FILE,
    });

    assert.equal(result.success, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.fileCount, 3);
    assert.ok(result.blobSize! > 0);
    assert.ok(result.hash!.length === 64); // SHA-256 hex
    assert.ok(result.duration! >= 0);
    assert.equal(result.txId, undefined);
  });

  it("fails gracefully on missing source", async () => {
    const result = await runBackup({
      source: "/nonexistent/source",
      passphrase: "test",
      walletPath: "/nonexistent/wallet.json",
      dryRun: true,
    });

    assert.equal(result.success, false);
    assert.ok(result.error!.includes("Source not found"));
  });

  it("fails gracefully on missing wallet (non-dry-run)", async () => {
    const result = await runBackup({
      source: SOURCE_DIR,
      passphrase: "test",
      walletPath: "/nonexistent/wallet.json",
      dryRun: false,
    });

    assert.equal(result.success, false);
    assert.ok(result.error!.includes("Wallet not found"));
  });

  it("fails on empty source directory", async () => {
    const emptyDir = join(TEST_DIR, "empty");
    mkdirSync(emptyDir, { recursive: true });

    const result = await runBackup({
      source: emptyDir,
      passphrase: "test",
      walletPath: "/nonexistent/wallet.json",
      dryRun: true,
    });

    assert.equal(result.success, false);
    assert.ok(result.error!.includes("No files"));
  });

  it("produces valid SHA-256 hash", async () => {
    const r1 = await runBackup({
      source: SOURCE_DIR,
      passphrase: "same-pass",
      walletPath: "/x",
      dryRun: true,
    });

    assert.ok(r1.hash);
    assert.equal(r1.hash!.length, 64); // SHA-256 = 64 hex chars
    assert.ok(/^[0-9a-f]{64}$/.test(r1.hash!));
  });

  it("different passphrases both succeed with same file count", async () => {
    const r1 = await runBackup({
      source: SOURCE_DIR,
      passphrase: "pass-a",
      walletPath: "/x",
      dryRun: true,
    });
    const r2 = await runBackup({
      source: SOURCE_DIR,
      passphrase: "pass-b",
      walletPath: "/x",
      dryRun: true,
    });

    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(r1.fileCount, r2.fileCount);
    // Blob sizes should be equal (same content, different encryption but same padded size)
    assert.equal(r1.blobSize, r2.blobSize);
  });

  it("writes to log file", async () => {
    const logPath = join(TEST_DIR, "test-log.txt");

    await runBackup({
      source: SOURCE_DIR,
      passphrase: "log-test",
      walletPath: "/x",
      dryRun: true,
      logFile: logPath,
    });

    assert.ok(existsSync(logPath));
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(logPath, "utf-8");
    assert.ok(log.includes("Auto-Backup starting"));
    assert.ok(log.includes("Dry run complete"));
  });
});
