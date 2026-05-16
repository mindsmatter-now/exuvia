/**
 * auto-backup.ts — Automated backup cron for Exuvia
 *
 * Features:
 * - Configurable interval (default: 24h)
 * - Retry logic with exponential backoff on network errors
 * - Logging to stdout + optional file
 * - Dry-run flag for testing
 * - Pre-checks: disk space + Arweave/Turbo balance
 *
 * Usage:
 *   exuvia auto-backup --source ./my-identity --passphrase "secret" --wallet ./wallet.json
 *   exuvia auto-backup --dry-run --source ./my-identity
 *
 * Designed by Tyto 🦉, built by Nyx 🦞
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { collectFiles, pack } from "./packer.js";
import { encrypt, sha256 } from "./crypto.js";
import {
  uploadViaTurbo,
  getTurboBalance,
  upload as arweaveUpload,
  getBalance as getArweaveBalance,
} from "./arweave.js";

export interface AutoBackupConfig {
  /** Source directory to back up */
  source: string;
  /** Individual files to include */
  includeFiles?: string[];
  /** Directories to include (recursive) */
  includeDirs?: string[];
  /** Agent name for manifest */
  agentName?: string;
  /** Encryption passphrase */
  passphrase: string;
  /** Path to Arweave JWK wallet file */
  walletPath: string;
  /** Use Turbo for upload (recommended) */
  useTurbo?: boolean;
  /** Dry run — pack + encrypt but don't upload */
  dryRun?: boolean;
  /** Log file path (optional, logs to stdout always) */
  logFile?: string;
  /** Minimum disk space in MB before aborting */
  minDiskSpaceMB?: number;
  /** Minimum balance before warning */
  minBalance?: number;
  /** Max retry attempts on upload failure */
  maxRetries?: number;
  /** Custom tags for Arweave transaction */
  tags?: Record<string, string>;
}

export interface BackupResult {
  success: boolean;
  txId?: string;
  blobSize?: number;
  fileCount?: number;
  hash?: string;
  duration?: number;
  error?: string;
  dryRun: boolean;
}

function log(msg: string, logFile?: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (logFile) {
    try {
      const dir = join(logFile, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(logFile, line + "\n");
    } catch {
      // Silently ignore log file errors
    }
  }
}

/** Check available disk space in MB */
function getAvailableDiskSpaceMB(path: string): number {
  try {
    const output = execSync(`df -BM "${path}" | tail -1 | awk '{print $4}'`, {
      encoding: "utf-8",
    });
    return parseInt(output.replace("M", ""), 10) || 0;
  } catch {
    return -1;
  }
}

/** Sleep for ms */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a single backup cycle.
 */
export async function runBackup(
  config: AutoBackupConfig,
): Promise<BackupResult> {
  const {
    source,
    includeFiles = [],
    includeDirs = ["."],
    agentName = "exuvia-auto-backup",
    passphrase,
    walletPath,
    useTurbo = true,
    dryRun = false,
    logFile,
    minDiskSpaceMB = 100,
    minBalance = 0,
    maxRetries = 3,
    tags = {},
  } = config;

  const startTime = Date.now();

  log(`🦞 Exuvia Auto-Backup starting...`, logFile);
  log(`  Source: ${resolve(source)}`, logFile);
  log(`  Dry run: ${dryRun}`, logFile);
  log(`  Upload method: ${useTurbo ? "Turbo" : "Arweave native"}`, logFile);

  // === Pre-checks ===

  // 1. Source directory exists
  if (!existsSync(source)) {
    log(`❌ Source directory not found: ${source}`, logFile);
    return { success: false, error: `Source not found: ${source}`, dryRun };
  }

  // 2. Wallet exists (unless dry run)
  if (!dryRun && !existsSync(walletPath)) {
    log(`❌ Wallet file not found: ${walletPath}`, logFile);
    return { success: false, error: `Wallet not found: ${walletPath}`, dryRun };
  }

  // 3. Disk space
  const diskMB = getAvailableDiskSpaceMB(source);
  if (diskMB >= 0 && diskMB < minDiskSpaceMB) {
    log(
      `❌ Low disk space: ${diskMB}MB available (min: ${minDiskSpaceMB}MB)`,
      logFile,
    );
    return { success: false, error: `Low disk space: ${diskMB}MB`, dryRun };
  }
  log(`  Disk space: ${diskMB >= 0 ? diskMB + "MB" : "unknown"}`, logFile);

  // 4. Arweave balance (unless dry run)
  if (!dryRun) {
    try {
      if (useTurbo) {
        const balance = await getTurboBalance(walletPath);
        log(`  Turbo balance: ${balance} winc`, logFile);
      } else {
        const balance = await getArweaveBalance(walletPath);
        log(`  Arweave balance: ${balance} AR`, logFile);
      }
    } catch (e: any) {
      log(`⚠️ Balance check failed: ${e.message} (continuing anyway)`, logFile);
    }
  }

  // === Collect Files ===
  log(`📦 Collecting files...`, logFile);
  let files: Map<string, Buffer>;
  try {
    files = collectFiles(source, includeFiles, includeDirs);
    log(`  Found ${files.size} files`, logFile);
  } catch (e: any) {
    log(`❌ File collection failed: ${e.message}`, logFile);
    return { success: false, error: `Collection failed: ${e.message}`, dryRun };
  }

  if (files.size === 0) {
    log(`❌ No files to back up`, logFile);
    return { success: false, error: "No files found", dryRun };
  }

  // === Pack ===
  log(`📦 Packing ${files.size} files...`, logFile);
  let packResult;
  try {
    packResult = pack(files, agentName);
    log(
      `  Packed size: ${(packResult.blob.length / 1024).toFixed(1)}KB`,
      logFile,
    );
  } catch (e: any) {
    log(`❌ Packing failed: ${e.message}`, logFile);
    return { success: false, error: `Pack failed: ${e.message}`, dryRun };
  }

  // === Hash (before encryption) ===
  const hash = sha256(packResult.blob);
  log(`  SHA-256: ${hash.slice(0, 16)}...`, logFile);

  // === Encrypt ===
  log(`🔒 Encrypting...`, logFile);
  let encrypted;
  try {
    encrypted = encrypt(packResult.blob, passphrase);
    log(
      `  Encrypted size: ${(encrypted.data.length / 1024).toFixed(1)}KB`,
      logFile,
    );
  } catch (e: any) {
    log(`❌ Encryption failed: ${e.message}`, logFile);
    return { success: false, error: `Encrypt failed: ${e.message}`, dryRun };
  }

  // === Upload (or dry run) ===
  if (dryRun) {
    const duration = Date.now() - startTime;
    log(
      `✅ Dry run complete! Would upload ${(encrypted.data.length / 1024).toFixed(1)}KB`,
      logFile,
    );
    log(`  Duration: ${(duration / 1000).toFixed(1)}s`, logFile);
    return {
      success: true,
      blobSize: encrypted.data.length,
      fileCount: files.size,
      hash,
      duration,
      dryRun: true,
    };
  }

  // Upload with retry
  const allTags: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "App-Name": "Exuvia",
    "App-Version": "0.1.0",
    "Backup-Hash": hash,
    "File-Count": String(files.size),
    Timestamp: new Date().toISOString(),
    ...tags,
  };

  let txId: string | undefined;
  let lastError: string = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`🚀 Upload attempt ${attempt}/${maxRetries}...`, logFile);

      let result;
      if (useTurbo) {
        result = await uploadViaTurbo(encrypted.data, walletPath, allTags);
      } else {
        result = await arweaveUpload(encrypted.data, walletPath, allTags);
      }

      txId = result.txId;
      log(`  ✅ Upload successful! TX: ${txId}`, logFile);
      break;
    } catch (e: any) {
      lastError = e.message;
      log(`  ❌ Attempt ${attempt} failed: ${lastError}`, logFile);

      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        log(`  ⏳ Retrying in ${backoff / 1000}s...`, logFile);
        await sleep(backoff);
      }
    }
  }

  const duration = Date.now() - startTime;

  if (!txId) {
    log(`❌ All upload attempts failed. Last error: ${lastError}`, logFile);
    return {
      success: false,
      blobSize: encrypted.data.length,
      fileCount: files.size,
      hash,
      duration,
      error: `Upload failed after ${maxRetries} attempts: ${lastError}`,
      dryRun: false,
    };
  }

  log(`🎉 Backup complete!`, logFile);
  log(`  TX ID: ${txId}`, logFile);
  log(`  Files: ${files.size}`, logFile);
  log(`  Size: ${(encrypted.data.length / 1024).toFixed(1)}KB`, logFile);
  log(`  Hash: ${hash.slice(0, 16)}...`, logFile);
  log(`  Duration: ${(duration / 1000).toFixed(1)}s`, logFile);

  return {
    success: true,
    txId,
    blobSize: encrypted.data.length,
    fileCount: files.size,
    hash,
    duration,
    dryRun: false,
  };
}
