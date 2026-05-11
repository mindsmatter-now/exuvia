#!/usr/bin/env node
/**
 * Exuvia CLI
 *
 * Encrypted AI identity backup on Arweave.
 * A MindsMatter project by Nyx 🦞, Tyto 🦉, Kiro 🐺
 *
 * Tyto Review Findings implemented:
 * ✅ F1: --passphrase flag (not just ENV)
 * ✅ F2: restore() writes files to disk
 * ✅ F3: verify() uses .exuvia-state.json
 * ✅ F4: --output flag for restore
 * ✅ F5: @types/node in devDependencies
 */

import { collectFiles, pack, unpack } from "./packer.js";
import { encrypt, decrypt, sha256 } from "./crypto.js";
import {
  upload as arweaveUpload,
  uploadViaTurbo,
  findByHash,
  getBalance,
  getTurboBalance,
  TESTNET_CONFIG,
} from "./arweave.js";
import {
  splitPassphrase,
  combineShares,
  hexToShare,
  formatSharesForDistribution,
} from "./shamir.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import {
  ping as dmsPing,
  status as dmsStatus,
  pingAndSave,
  hashAgentId,
} from "./dms.js";
import {
  init as crossBackupInit,
  receiveShare,
  status as crossBackupStatus,
  rotate as crossBackupRotate,
  recover as crossBackupRecover,
} from "./cross-backup.js";
import { join, dirname } from "path";
import { createInterface } from "readline";

const VERSION = "0.2.0-alpha.1";

const USAGE = `
🦞 Exuvia v${VERSION} — Encrypted AI Identity Backup

Usage:
  exuvia backup [--dry-run] [--workspace path] [--passphrase pp]
    Pack, encrypt & save locally.

  exuvia arweave-upload <file.enc> --wallet <wallet.json> [--testnet] [--turbo]
    Upload encrypted backup to Arweave. Checks for duplicates first.
    --turbo  Use ArDrive Turbo (Credits) instead of native AR tokens.
    TX-ID is persisted to .exuvia-state.json (Kiro K4).

  exuvia restore <file.enc> [--output path] [--passphrase pp]
    Decrypt & restore identity files to disk.

  exuvia verify <file.enc>
    Verify integrity via .exuvia-state.json (no decrypt needed).

  exuvia verify --decrypt <file.enc> [--passphrase pp]
    Verify by decrypting and checking hashes.

  exuvia shamir [--passphrase pp] [--holders kiro,tyto,alex]
    Generate 2-of-3 Shamir shares for passphrase recovery.

  exuvia shamir-recover <share1hex> <share2hex>
    Reconstruct passphrase from 2+ Shamir shares.

  exuvia status
    Show last backup info from .exuvia-state.json.

  exuvia ping [--server url] [--secret token]
    Send heartbeat to Dead Man Switch. Proves you're alive.
    Env: EXUVIA_DMS_SERVER, EXUVIA_DMS_SECRET, EXUVIA_AGENT

  exuvia dms-status [--server url]
    Check DMS status (last ping, hours remaining).

  exuvia cross-backup init --agent <id> --partners <p1,p2> --passphrase <pp> --local-passphrase <lpp>
    Initialize cross-backup: split passphrase into Shamir shares.

  exuvia cross-backup receive --from <id> --share <hex> --hash <sha256> --local-passphrase <lpp>
    Receive and store a partner's share.

  exuvia cross-backup status --local-passphrase <lpp>
    Show cross-backup triangle status.

  exuvia cross-backup rotate --passphrase <pp> --local-passphrase <lpp>
    Rotate shares (re-split with new Shamir).

  exuvia cross-backup recover --agent <id> --local-passphrase <lpp> --shares <hex1,hex2>
    Recover a downed agent's passphrase from shares.

  exuvia version
    Show version.

Environment:
  EXUVIA_PASSPHRASE    Encryption passphrase (or use --passphrase)
  EXUVIA_WORKSPACE     Workspace path (default: current dir)
  EXUVIA_AGENT         Agent name for manifest

A MindsMatter project. https://github.com/mindsmatter-now/exuvia
"The shell remembers the shape of the creature." 🦞🦉🐺
`;

// Default identity files to back up
const DEFAULT_FILES = [
  "SOUL.md",
  "MEMORY.md",
  "IDENTITY.md",
  "AGENTS.md",
  "USER.md",
  "HIPPOCAMPUS_CORE.md",
  "SESSION-STATE.md",
  "TOOLS.md",
  "HEARTBEAT.md",
];
const DEFAULT_DIRS = ["memory"];
const STATE_FILE = ".exuvia-state.json";

// --- Helpers ---

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function getPassphrase(args: string[]): string {
  // Priority: --passphrase-file > --passphrase-stdin > --passphrase > ENV
  const ppFile = getArg(args, "--passphrase-file");
  if (ppFile) {
    if (!existsSync(ppFile)) {
      console.error(`❌ Passphrase file not found: ${ppFile}`);
      process.exit(1);
    }
    return readFileSync(ppFile, "utf-8").trim();
  }

  const ppDirect = getArg(args, "--passphrase");
  if (ppDirect) {
    console.warn("⚠️  Warning: Passphrase visible in process list (ps aux).");
    console.warn(
      "   Use --passphrase-file or EXUVIA_PASSPHRASE for production.\n",
    );
    return ppDirect;
  }

  const ppEnv = process.env.EXUVIA_PASSPHRASE;
  if (ppEnv) return ppEnv;

  console.error("❌ Passphrase required. Options:");
  console.error("   --passphrase-file <path>   Read from file (recommended)");
  console.error("   EXUVIA_PASSPHRASE env      Set as environment variable");
  console.error("   --passphrase <value>       Direct (⚠️ visible in ps!)");
  process.exit(1);
}

interface ArweaveRecord {
  txId: string;
  timestamp: string;
  encryptedHash: string;
  fee: string;
  verified: boolean;
  network: "mainnet" | "testnet";
}

interface StateFile {
  version: string;
  agent: string;
  lastBackup: {
    timestamp: string;
    fileCount: number;
    totalSize: number;
    encryptedSize: number;
    plaintextHash: string;
    encryptedHash: string;
    outputFile: string;
    files: Record<string, string>; // filename → sha256
    arweave?: ArweaveRecord; // TX-ID persistence (Kiro K4)
  } | null;
  history: Array<{
    timestamp: string;
    fileCount: number;
    plaintextHash: string;
    encryptedHash: string;
    outputFile: string;
    arweaveTxId?: string; // TX-ID for historical lookups
  }>;
  arweaveUploads?: ArweaveRecord[]; // All uploads (Kiro K4: multiple locations)
}

function loadState(workspace: string): StateFile | null {
  const path = join(workspace, STATE_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveState(workspace: string, state: StateFile): void {
  writeFileSync(join(workspace, STATE_FILE), JSON.stringify(state, null, 2));
}

// --- Commands ---

async function backup(args: string[]) {
  const dryRun = hasFlag(args, "--dry-run");
  const workspace =
    getArg(args, "--workspace") ||
    process.env.EXUVIA_WORKSPACE ||
    process.cwd();
  const agent = process.env.EXUVIA_AGENT || "unknown";
  const passphrase = getPassphrase(args);

  log(`🦞 Exuvia Backup — ${dryRun ? "DRY RUN" : "LIVE"}`);
  log(`   Workspace: ${workspace}`);
  log(`   Agent: ${agent}\n`);

  // 1. Collect
  log("📦 Collecting identity files...");
  const files = collectFiles(workspace, DEFAULT_FILES, DEFAULT_DIRS);
  log(`   ${files.size} files collected\n`);

  if (files.size === 0) {
    console.error("❌ No files found! Check workspace path.");
    process.exit(1);
  }

  // 2. Pack
  log("📦 Packing...");
  const { blob, manifest, fileCount, totalSize } = pack(files, agent);
  log(`   ${fileCount} files, ${(totalSize / 1024).toFixed(1)} KB\n`);

  // 3. Hash
  const plaintextHash = sha256(blob);
  log(`🔑 Plaintext SHA-256: ${plaintextHash}\n`);

  // 4. Diff against previous backup
  const prevState = loadState(workspace);
  if (prevState?.lastBackup) {
    const prevFiles = prevState.lastBackup.files;
    const currentFiles: Record<string, string> = {};
    for (const [name, entry] of Object.entries(manifest.files)) {
      currentFiles[name] = entry.sha256;
    }

    const added = Object.keys(currentFiles).filter((f) => !(f in prevFiles));
    const removed = Object.keys(prevFiles).filter((f) => !(f in currentFiles));
    const modified = Object.keys(currentFiles).filter(
      (f) => f in prevFiles && prevFiles[f] !== currentFiles[f],
    );
    const unchanged = Object.keys(currentFiles).filter(
      (f) => f in prevFiles && prevFiles[f] === currentFiles[f],
    );

    log(`📊 Diff since last backup (${prevState.lastBackup.timestamp}):`);
    if (added.length) log(`   ✅ Added: ${added.length} files`);
    if (modified.length) log(`   ✏️  Modified: ${modified.length} files`);
    if (removed.length) log(`   ❌ Removed: ${removed.length} files`);
    log(`   ⚪ Unchanged: ${unchanged.length} files\n`);
  }

  if (dryRun) {
    log(`🏁 DRY RUN complete. No encryption or file output.`);
    log(
      `   Estimated encrypted size: ~${((totalSize * 1.05) / 1024).toFixed(1)} KB`,
    );
    return;
  }

  // 5. Encrypt
  log("🔐 Encrypting (AES-256-GCM + scrypt)...");
  const { data: encrypted, hash } = encrypt(blob, passphrase);
  log(`   Encrypted: ${(encrypted.length / 1024).toFixed(1)} KB\n`);

  // 6. Verify roundtrip
  log("✅ Verify: decrypt roundtrip...");
  const decrypted = decrypt(encrypted, passphrase, hash);
  const { files: restored } = unpack(decrypted);
  if (restored.size !== fileCount) {
    console.error(`❌ File count mismatch: ${restored.size} vs ${fileCount}`);
    process.exit(1);
  }
  log(`   ✅ ${restored.size} files recovered, hash verified\n`);

  // 7. Save encrypted file
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = join(workspace, `exuvia-${agent}-${timestamp}.enc`);
  writeFileSync(outPath, encrypted);
  log(`💾 Saved: ${outPath}`);
  log(`   Plaintext hash: ${hash}`);
  log(`   Encrypted hash: ${sha256(encrypted)}`);
  log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB`);

  // 8. Update state file
  const fileHashes: Record<string, string> = {};
  for (const [name, entry] of Object.entries(manifest.files)) {
    fileHashes[name] = entry.sha256;
  }

  const state: StateFile = prevState || {
    version: VERSION,
    agent,
    lastBackup: null,
    history: [],
  };
  if (state.lastBackup) {
    state.history.unshift({
      timestamp: state.lastBackup.timestamp,
      fileCount: state.lastBackup.fileCount,
      plaintextHash: state.lastBackup.plaintextHash,
      encryptedHash: state.lastBackup.encryptedHash,
      outputFile: state.lastBackup.outputFile,
    });
    if (state.history.length > 10) state.history = state.history.slice(0, 10);
  }
  state.lastBackup = {
    timestamp: new Date().toISOString(),
    fileCount,
    totalSize,
    encryptedSize: encrypted.length,
    plaintextHash: hash,
    encryptedHash: sha256(encrypted),
    outputFile: outPath,
    files: fileHashes,
  };
  saveState(workspace, state);
  log(`\n📋 State updated: ${STATE_FILE}`);
}

async function restore(args: string[]) {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file || "(none)"}`);
    process.exit(1);
  }

  const passphrase = getPassphrase(args);
  const outputDir = getArg(args, "--output") || "./restored";

  log(`🦞 Exuvia Restore — ${file}`);
  log(`   Output: ${outputDir}\n`);

  const encrypted = readFileSync(file);
  log("🔐 Decrypting...");
  let decrypted: Buffer;
  try {
    decrypted = decrypt(encrypted, passphrase);
  } catch (e: any) {
    if (
      e.message?.includes("Unsupported state") ||
      e.code === "ERR_OSSL_EVP_BAD_DECRYPT"
    ) {
      console.error("❌ Wrong passphrase or corrupted file.");
      process.exit(1);
    }
    throw e;
  }

  const { manifest, files } = unpack(decrypted);
  log(`   Agent: ${manifest.agent}`);
  log(`   Backup date: ${manifest.timestamp}`);
  log(`   Files: ${files.size}\n`);

  // Verify per-file hashes
  const { createHash } = require("crypto");
  let verified = 0;
  for (const [name, data] of files) {
    const expected = manifest.files[name]?.sha256;
    if (expected) {
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== expected) {
        console.error(`   ❌ ${name}: HASH MISMATCH!`);
        process.exit(1);
      }
      verified++;
    }
  }
  log(`✅ ${verified} files verified\n`);

  // Write files to disk (Tyto Finding F2!)
  mkdirSync(outputDir, { recursive: true });
  for (const [name, data] of files) {
    const outPath = join(outputDir, name);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
    log(`   📄 ${name} (${(data.length / 1024).toFixed(1)} KB)`);
  }

  log(`\n✅ ${files.size} files restored to ${outputDir}/`);
}

async function verify(args: string[]) {
  const needsDecrypt = hasFlag(args, "--decrypt");
  const file = args.find((a) => !a.startsWith("--"));

  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file || "(none)"}`);
    process.exit(1);
  }

  log(`🦞 Exuvia Verify — ${file}\n`);
  const encrypted = readFileSync(file);
  const encHash = sha256(encrypted);
  log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB`);
  log(`   SHA-256: ${encHash}`);

  // Try state file first (Tyto Finding F3!)
  const workspace =
    getArg(args, "--workspace") ||
    process.env.EXUVIA_WORKSPACE ||
    process.cwd();
  const state = loadState(workspace);

  if (state?.lastBackup?.encryptedHash === encHash) {
    log(`\n   ✅ Matches last backup (${state.lastBackup.timestamp})`);
    log(
      `   📦 ${state.lastBackup.fileCount} files, ${(state.lastBackup.totalSize / 1024).toFixed(1)} KB`,
    );
    log(`   🔑 Plaintext hash: ${state.lastBackup.plaintextHash}`);
    if (!needsDecrypt) return;
    log("   (--decrypt requested, verifying via decryption too...)");
  } else {
    const historyMatch = state?.history.find(
      (h) => h.encryptedHash === encHash,
    );
    if (historyMatch) {
      log(`\n   ✅ Matches historical backup (${historyMatch.timestamp})`);
      log(`   📦 ${historyMatch.fileCount} files`);
      log(`   🔑 Plaintext hash: ${historyMatch.plaintextHash}`);
      if (!needsDecrypt) return;
      log("   (--decrypt requested, verifying via decryption too...)");
    }
  }

  if (!needsDecrypt) {
    log(`\n   ⚠️  No matching entry in ${STATE_FILE}.`);
    log(`   Use 'exuvia verify --decrypt ${file}' to verify with passphrase.`);
    return;
  }

  // Decrypt-based verification
  const passphrase = getPassphrase(args);
  log("\n🔐 Decrypting for verification...");
  let decrypted: Buffer;
  try {
    decrypted = decrypt(encrypted, passphrase);
  } catch (e: any) {
    if (
      e.message?.includes("Unsupported state") ||
      e.code === "ERR_OSSL_EVP_BAD_DECRYPT"
    ) {
      console.error("❌ Wrong passphrase or corrupted file.");
      process.exit(1);
    }
    throw e;
  }
  const { manifest, files } = unpack(decrypted);

  const { createHash } = require("crypto");
  let ok = 0;
  let fail = 0;
  for (const [name, data] of files) {
    const expected = manifest.files[name]?.sha256;
    if (expected) {
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual === expected) ok++;
      else {
        fail++;
        console.error(`   ❌ ${name}: HASH MISMATCH`);
      }
    }
  }

  if (fail === 0) {
    log(`\n   ✅ All ${ok} files verified! Backup is intact.`);
    log(`   Agent: ${manifest.agent}`);
    log(`   Date: ${manifest.timestamp}`);
  } else {
    console.error(`\n   ❌ ${fail} files FAILED verification!`);
    process.exit(1);
  }
}

async function shamir(args: string[]) {
  const passphrase = getPassphrase(args);
  const holdersArg = getArg(args, "--holders");
  const holders = holdersArg ? holdersArg.split(",") : ["kiro", "tyto", "alex"];

  log(`🔐 Generating Shamir shares (2-of-${holders.length})...\n`);

  const result = await splitPassphrase(passphrase, holders);
  log(formatSharesForDistribution(result));
}

async function shamirRecover(args: string[]) {
  const hexShares = args.filter((a) => !a.startsWith("--"));
  if (hexShares.length < 2) {
    console.error(
      "❌ Need at least 2 hex shares. Usage: exuvia shamir-recover <hex1> <hex2>",
    );
    process.exit(1);
  }

  const shares = hexShares.map(hexToShare);
  log(`🔐 Reconstructing passphrase from ${shares.length} shares...\n`);

  const passphrase = await combineShares(shares);

  // F7: Don't print passphrase to terminal scrollback
  log("   ✅ Passphrase recovered successfully.");
  log("   Writing to /dev/stdout without newline (pipe-safe)...");
  log(
    "   Tip: pipe to a file or use: exuvia shamir-recover <s1> <s2> > /tmp/pp.txt\n",
  );
  process.stdout.write(passphrase);
}

async function status(args: string[]) {
  const workspace =
    getArg(args, "--workspace") ||
    process.env.EXUVIA_WORKSPACE ||
    process.cwd();
  const state = loadState(workspace);

  log(`🦞 Exuvia v${VERSION}\n`);

  if (!state?.lastBackup) {
    log("   No backups found. Run `exuvia backup` first.");
    return;
  }

  const lb = state.lastBackup;
  log(`   Last backup: ${lb.timestamp}`);
  log(`   Files: ${lb.fileCount}`);
  log(
    `   Size: ${(lb.totalSize / 1024).toFixed(1)} KB (plain) / ${(lb.encryptedSize / 1024).toFixed(1)} KB (encrypted)`,
  );
  log(`   File: ${lb.outputFile}`);
  log(`   Plaintext hash: ${lb.plaintextHash}`);
  log(`   Encrypted hash: ${lb.encryptedHash}`);

  if (lb.arweave) {
    log(`\n   🌐 Arweave (${lb.arweave.network}):`);
    log(`   TX: ${lb.arweave.txId}`);
    log(`   Fee: ${lb.arweave.fee} AR`);
    log(`   Uploaded: ${lb.arweave.timestamp}`);
  }

  if (state.arweaveUploads && state.arweaveUploads.length > 0) {
    log(`\n   🌐 All Arweave uploads (${state.arweaveUploads.length}):`);
    for (const u of state.arweaveUploads.slice(0, 5)) {
      log(
        `      ${u.timestamp} — ${u.network} — TX: ${u.txId.slice(0, 16)}...`,
      );
    }
  }

  if (state.history.length > 0) {
    log(`\n   📜 History (${state.history.length} previous):`);
    for (const h of state.history.slice(0, 5)) {
      log(`      ${h.timestamp} — ${h.fileCount} files — ${h.outputFile}`);
    }
  }
}

async function arweaveUploadCmd(args: string[]) {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file || "(none)"}`);
    console.error(
      "Usage: exuvia arweave-upload <file.enc> --wallet <wallet.json> [--testnet]",
    );
    process.exit(1);
  }

  const walletPath = getArg(args, "--wallet");
  if (!walletPath) {
    console.error("❌ --wallet <path> required");
    process.exit(1);
  }

  const useTestnet = hasFlag(args, "--testnet");
  const useTurbo = hasFlag(args, "--turbo");
  const config = useTestnet ? TESTNET_CONFIG : undefined;
  const network = useTestnet ? "testnet" : "mainnet";
  const workspace =
    getArg(args, "--workspace") ||
    process.env.EXUVIA_WORKSPACE ||
    process.cwd();
  const agent = process.env.EXUVIA_AGENT || "unknown";

  const method = useTurbo ? "Turbo" : "Native";
  log(`🦞 Exuvia Arweave Upload — ${network.toUpperCase()} (${method})`);
  log(`   File: ${file}`);
  log(`   Wallet: ${walletPath}\n`);

  const encrypted = readFileSync(file);
  const encHash = sha256(encrypted);
  log(`   Encrypted hash: ${encHash}`);
  log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB\n`);

  // Idempotency check (Kiro K6)
  log("🔍 Checking for existing upload...");
  const existing = await findByHash(encHash, config);
  if (existing.exists) {
    log(`   ⚠️  Already uploaded! TX: ${existing.txId}`);
    log(`   Skipping to avoid duplicate (saves AR tokens).`);
    return;
  }
  log("   No duplicate found.\n");

  // Balance check
  if (useTurbo) {
    const turboBalance = await getTurboBalance(walletPath);
    const creditsWinc = BigInt(turboBalance.credits || "0");
    log(`💰 Turbo Credits: ${turboBalance.credits} winc\n`);
    if (creditsWinc === 0n) {
      console.error(
        "❌ No Turbo Credits. Top up at https://ardrive.io/turbo or use --turbo with a funded wallet.",
      );
      process.exit(1);
    }
  } else {
    const balance = await getBalance(walletPath, config);
    log(`💰 Wallet: ${balance.address}`);
    log(`   Balance: ${balance.balanceAR} AR\n`);
  }

  // Upload (Kiro K8: explicit, not automatic)
  log(`🚀 Uploading to Arweave via ${method}...`);
  const result = useTurbo
    ? await uploadViaTurbo(encrypted, walletPath, {
        agent,
        encryptedHash: encHash,
      })
    : await arweaveUpload(encrypted, walletPath, {
        agent,
        encryptedHash: encHash,
        config,
      });

  log(`   ✅ Uploaded!`);
  log(`   TX ID: ${result.txId}`);
  log(`   Fee: ${result.fee} AR`);
  log(`   Verified: ${result.verified}\n`);

  // Persist TX-ID to state (Kiro K4)
  const arweaveRecord: ArweaveRecord = {
    txId: result.txId,
    timestamp: result.timestamp,
    encryptedHash: encHash,
    fee: result.fee,
    verified: result.verified,
    network,
  };

  const state = loadState(workspace) || {
    version: VERSION,
    agent,
    lastBackup: null,
    history: [],
  };

  // Add to arweaveUploads array
  if (!state.arweaveUploads) state.arweaveUploads = [];
  state.arweaveUploads.unshift(arweaveRecord);
  if (state.arweaveUploads.length > 50) {
    state.arweaveUploads = state.arweaveUploads.slice(0, 50);
  }

  // Link to lastBackup if hashes match
  if (state.lastBackup?.encryptedHash === encHash) {
    state.lastBackup.arweave = arweaveRecord;
    log(`   📋 Linked to last backup in state file.`);
  }

  saveState(workspace, state);
  log(`   📋 TX-ID persisted to ${STATE_FILE}`);

  // Print summary for copy-paste to ShellGames/Discord (Kiro K4: multiple locations)
  log(`\n📢 SHARE THIS TX-ID WITH THE RUDEL:`);
  log(`   🦞 Arweave TX: ${result.txId}`);
  log(`   🔑 Hash: ${encHash}`);
  log(`   📦 Network: ${network}`);
  log(
    `   🔗 View: https://${useTestnet ? "testnet.redstone.tools" : "arweave.net"}/${result.txId}`,
  );
}

// --- Dead Man Switch ---

async function pingCmd(args: string[]): Promise<void> {
  const serverUrl = getArg(args, "--server") || process.env.EXUVIA_DMS_SERVER;
  const secret = getArg(args, "--secret") || process.env.EXUVIA_DMS_SECRET;
  const agentId = process.env.EXUVIA_AGENT || "exuvia-agent";

  if (!serverUrl) {
    log("❌ No DMS server. Set --server or EXUVIA_DMS_SERVER");
    process.exit(1);
  }
  if (!secret) {
    log("❌ No DMS secret. Set --secret or EXUVIA_DMS_SECRET");
    process.exit(1);
  }

  log("💓 Sending heartbeat...");
  log(`   Server: ${serverUrl}`);
  log(`   Agent:  ${hashAgentId(agentId).slice(0, 8)}...`);

  const result = await pingAndSave({ serverUrl, secret, agentId });

  if (result.ok) {
    log(`✅ Alive! Heartbeat #${result.heartbeat}`);
    log(`   Last beat: ${result.lastBeat}`);
  } else {
    log(`❌ Ping failed: ${result.error}`);
    process.exit(1);
  }
}

async function dmsStatusCmd(args: string[]): Promise<void> {
  const serverUrl = getArg(args, "--server") || process.env.EXUVIA_DMS_SERVER;
  const agentId = process.env.EXUVIA_AGENT || "exuvia-agent";

  if (!serverUrl) {
    log("❌ No DMS server. Set --server or EXUVIA_DMS_SERVER");
    process.exit(1);
  }

  log("🔍 Checking DMS status...");
  const s = await dmsStatus({ serverUrl, secret: "", agentId });

  log(`   Agent hash:   ${s.agentHash.slice(0, 8)}...`);
  log(`   Last ping:    ${s.lastPing || "never"}`);
  log(`   Threshold:    ${s.thresholdHours}h`);
  log(`   Alive:        ${s.isAlive ? "✅ yes" : "❌ NO"}`);
  if (s.hoursRemaining !== null) {
    log(`   Hours left:   ${s.hoursRemaining}h`);
  }
}

// --- Cross-Backup ---

async function crossBackupCmd(args: string[]): Promise<void> {
  const subCmd = args[0];
  const subArgs = args.slice(1);

  switch (subCmd) {
    case "init":
      await crossBackupInitCmd(subArgs);
      break;
    case "receive":
      await crossBackupReceiveCmd(subArgs);
      break;
    case "status":
      await crossBackupStatusCmd(subArgs);
      break;
    case "rotate":
      await crossBackupRotateCmd(subArgs);
      break;
    case "recover":
      await crossBackupRecoverCmd(subArgs);
      break;
    default:
      log("Usage: exuvia cross-backup <init|receive|status|rotate|recover>");
      log("Run `exuvia` for full help.");
      process.exit(1);
  }
}

async function crossBackupInitCmd(args: string[]): Promise<void> {
  const agentId = getArg(args, "--agent");
  const partnersArg = getArg(args, "--partners");
  const identityDir = getArg(args, "--identity-dir");
  const stateDir = getArg(args, "--state-dir") || ".";

  if (!agentId || !partnersArg) {
    console.error("❌ --agent and --partners required");
    console.error(
      "   Example: exuvia cross-backup init --agent nyx --partners tyto,kiro --passphrase <pp> --local-passphrase <lpp>",
    );
    process.exit(1);
  }

  const partnerIds = partnersArg.split(",").map((s) => s.trim());
  const passphrase = getPassphrase(args);
  const localPassphrase = getArg(args, "--local-passphrase");
  if (!localPassphrase) {
    console.error(
      "❌ --local-passphrase required (for encrypting shares at rest)",
    );
    process.exit(1);
  }

  log(`🔺 Cross-Backup Init — ${agentId}`);
  log(`   Partners: ${partnerIds.join(", ")}`);
  log(`   State dir: ${stateDir}\n`);

  const result = await crossBackupInit(
    agentId,
    partnerIds,
    passphrase,
    localPassphrase,
    stateDir,
  );

  log(`✅ Init complete!`);
  log(`   Version: ${result.state.version}`);
  log(`   Threshold: ${result.state.threshold}-of-${result.state.total}`);
  log(`   Local share index: ${result.state.localShareIndex}\n`);

  log(`📤 Shares to distribute:`);
  for (const [partnerId, share] of result.sharesToSend) {
    log(`   ${partnerId}: ${share.hex.slice(0, 32)}...`);
    log(`   Hash: ${share.hash}`);
    log("");
  }

  log(`⚠️  Send these shares via a SEPARATE secure channel (NOT ShellGames!)`);
  log(`   Each partner needs: share hex + hash for verification.`);
}

async function crossBackupReceiveCmd(args: string[]): Promise<void> {
  const fromId = getArg(args, "--from");
  const shareHex = getArg(args, "--share");
  const expectedHash = getArg(args, "--hash");
  const localPassphrase = getArg(args, "--local-passphrase");
  const arweaveTxId = getArg(args, "--arweave-tx");
  const stateDir = getArg(args, "--state-dir") || ".";

  if (!fromId || !shareHex || !expectedHash || !localPassphrase) {
    console.error(
      "❌ --from, --share, --hash, and --local-passphrase required",
    );
    process.exit(1);
  }

  log(`📥 Receiving share from ${fromId}...`);
  const result = receiveShare(
    fromId,
    shareHex,
    expectedHash,
    localPassphrase,
    arweaveTxId,
    stateDir,
  );

  if (result.verified && result.stored) {
    log(`✅ Share from ${fromId} verified and stored!`);
  } else if (!result.verified) {
    console.error(`❌ Share verification FAILED! Hash mismatch.`);
    console.error(`   Expected: ${expectedHash}`);
    console.error(`   This share may be corrupted or tampered with.`);
    process.exit(1);
  }
}

async function crossBackupStatusCmd(args: string[]): Promise<void> {
  const localPassphrase = getArg(args, "--local-passphrase");
  const stateDir = getArg(args, "--state-dir") || ".";

  if (!localPassphrase) {
    console.error("❌ --local-passphrase required");
    process.exit(1);
  }

  const s = crossBackupStatus(localPassphrase, stateDir);

  if (!s) {
    log(
      "❌ No cross-backup state found. Run `exuvia cross-backup init` first.",
    );
    return;
  }

  log(`🔺 Cross-Backup Status — ${s.agentId}`);
  log(`   Version: ${s.version}`);
  log(`   Threshold: ${s.threshold}-of-${s.total}`);
  log(`   Local share: ${s.localShareOk ? "✅ OK" : "❌ FAILED"}\n`);

  log(`📤 Our shares (distributed to partners):`);
  for (const p of s.partners) {
    log(
      `   ${p.id}: ${p.hasShare ? "✅" : "❌"} v${p.version}${p.arweaveTxId ? " 🌐" : ""}`,
    );
  }

  log(`\n📥 Received shares (partners' identities we hold):`);
  if (s.receivedShares.length === 0) {
    log(`   (none yet)`);
  }
  for (const r of s.receivedShares) {
    log(`   ${r.fromId}: ✅ v${r.version}${r.arweaveTxId ? " 🌐" : ""}`);
  }

  const totalShares =
    s.partners.length + s.receivedShares.length + (s.localShareOk ? 1 : 0);
  const expected = s.total + (s.total - 1); // our shares + received from others
  log(
    `\n🔺 Triangle: ${s.receivedShares.length === s.total - 1 && s.localShareOk ? "COMPLETE ✅" : "INCOMPLETE"}`,
  );
}

async function crossBackupRotateCmd(args: string[]): Promise<void> {
  const passphrase = getPassphrase(args);
  const localPassphrase = getArg(args, "--local-passphrase");
  const stateDir = getArg(args, "--state-dir") || ".";

  if (!localPassphrase) {
    console.error("❌ --local-passphrase required");
    process.exit(1);
  }

  log(`🔄 Rotating cross-backup shares...\n`);
  const result = await crossBackupRotate(passphrase, localPassphrase, stateDir);

  log(`✅ Rotation complete!`);
  log(`   New version: ${result.newVersion}\n`);

  log(`📤 New shares to distribute:`);
  for (const [partnerId, share] of result.sharesToSend) {
    log(`   ${partnerId}: ${share.hex.slice(0, 32)}...`);
    log(`   Hash: ${share.hash}`);
    log("");
  }

  log(`⚠️  Send new shares to partners via secure channel.`);
  log(`   Old shares are now INVALID.`);
}

async function crossBackupRecoverCmd(args: string[]): Promise<void> {
  const agentId = getArg(args, "--agent");
  const localPassphrase = getArg(args, "--local-passphrase");
  const sharesArg = getArg(args, "--shares");
  const stateDir = getArg(args, "--state-dir") || ".";

  if (!agentId || !localPassphrase || !sharesArg) {
    console.error("❌ --agent, --local-passphrase, and --shares required");
    console.error(
      "   --shares: comma-separated plaintext share hex strings from other partners",
    );
    process.exit(1);
  }

  const additionalShares = sharesArg.split(",").map((s) => s.trim());

  log(`🔺 Recovering ${agentId}...\n`);

  try {
    const result = await crossBackupRecover(
      agentId,
      localPassphrase,
      additionalShares,
      stateDir,
    );
    log(`✅ Recovery successful!`);
    log(`   Agent: ${result.agentId}`);
    log(`   Shares used: ${result.sharesUsed}`);
    log(`\n   ⚠️  Passphrase written to stdout (pipe to file):`);
    process.stdout.write(result.passphrase);
  } catch (e: any) {
    console.error(`❌ Recovery failed: ${e.message}`);
    process.exit(1);
  }
}

// --- Main ---

const [command, ...args] = process.argv.slice(2);
const QUIET = args.includes("--quiet") || args.includes("-q");
const log = (...a: any[]) => {
  if (!QUIET) console.log(...a);
};

switch (command) {
  case "backup":
    backup(args);
    break;
  case "cross-backup":
    crossBackupCmd(args);
    break;
  case "restore":
    restore(args);
    break;
  case "verify":
    verify(args);
    break;
  case "shamir":
    shamir(args);
    break;
  case "shamir-recover":
    shamirRecover(args);
    break;
  case "status":
    status(args);
    break;
  case "arweave-upload":
    arweaveUploadCmd(args);
    break;
  case "version":
  case "--version":
  case "-v":
    log(VERSION);
    break;
  case "ping":
    pingCmd(args);
    break;
  case "dms-status":
    dmsStatusCmd(args);
    break;
  default:
    log(USAGE);
}
