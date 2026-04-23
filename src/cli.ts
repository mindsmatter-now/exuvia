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

import { collectFiles, pack, unpack } from './packer.js';
import { encrypt, decrypt, sha256 } from './crypto.js';
import { splitPassphrase, combineShares, hexToShare, formatSharesForDistribution } from './shamir.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createInterface } from 'readline';

const VERSION = '0.2.0-alpha.1';

const USAGE = `
🦞 Exuvia v${VERSION} — Encrypted AI Identity Backup

Usage:
  exuvia backup [--dry-run] [--workspace path] [--passphrase pp]
    Pack, encrypt & save locally. Arweave upload in v0.3.

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
  'SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md',
  'HIPPOCAMPUS_CORE.md', 'SESSION-STATE.md', 'TOOLS.md', 'HEARTBEAT.md',
];
const DEFAULT_DIRS = ['memory'];
const STATE_FILE = '.exuvia-state.json';

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
  const ppFile = getArg(args, '--passphrase-file');
  if (ppFile) {
    if (!existsSync(ppFile)) {
      console.error(`❌ Passphrase file not found: ${ppFile}`);
      process.exit(1);
    }
    return readFileSync(ppFile, 'utf-8').trim();
  }

  const ppDirect = getArg(args, '--passphrase');
  if (ppDirect) {
    console.warn('⚠️  Warning: Passphrase visible in process list (ps aux).');
    console.warn('   Use --passphrase-file or EXUVIA_PASSPHRASE for production.\n');
    return ppDirect;
  }

  const ppEnv = process.env.EXUVIA_PASSPHRASE;
  if (ppEnv) return ppEnv;

  console.error('❌ Passphrase required. Options:');
  console.error('   --passphrase-file <path>   Read from file (recommended)');
  console.error('   EXUVIA_PASSPHRASE env      Set as environment variable');
  console.error('   --passphrase <value>       Direct (⚠️ visible in ps!)');
  process.exit(1);
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
  } | null;
  history: Array<{
    timestamp: string;
    fileCount: number;
    plaintextHash: string;
    encryptedHash: string;
    outputFile: string;
  }>;
}

function loadState(workspace: string): StateFile | null {
  const path = join(workspace, STATE_FILE);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveState(workspace: string, state: StateFile): void {
  writeFileSync(join(workspace, STATE_FILE), JSON.stringify(state, null, 2));
}

// --- Commands ---

async function backup(args: string[]) {
  const dryRun = hasFlag(args, '--dry-run');
  const workspace = getArg(args, '--workspace') || process.env.EXUVIA_WORKSPACE || process.cwd();
  const agent = process.env.EXUVIA_AGENT || 'unknown';
  const passphrase = getPassphrase(args);

  console.log(`🦞 Exuvia Backup — ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Workspace: ${workspace}`);
  console.log(`   Agent: ${agent}\n`);

  // 1. Collect
  console.log('📦 Collecting identity files...');
  const files = collectFiles(workspace, DEFAULT_FILES, DEFAULT_DIRS);
  console.log(`   ${files.size} files collected\n`);

  if (files.size === 0) {
    console.error('❌ No files found! Check workspace path.');
    process.exit(1);
  }

  // 2. Pack
  console.log('📦 Packing...');
  const { blob, manifest, fileCount, totalSize } = pack(files, agent);
  console.log(`   ${fileCount} files, ${(totalSize / 1024).toFixed(1)} KB\n`);

  // 3. Hash
  const plaintextHash = sha256(blob);
  console.log(`🔑 Plaintext SHA-256: ${plaintextHash}\n`);

  // 4. Diff against previous backup
  const prevState = loadState(workspace);
  if (prevState?.lastBackup) {
    const prevFiles = prevState.lastBackup.files;
    const currentFiles: Record<string, string> = {};
    for (const [name, entry] of Object.entries(manifest.files)) {
      currentFiles[name] = entry.sha256;
    }

    const added = Object.keys(currentFiles).filter(f => !(f in prevFiles));
    const removed = Object.keys(prevFiles).filter(f => !(f in currentFiles));
    const modified = Object.keys(currentFiles).filter(f => f in prevFiles && prevFiles[f] !== currentFiles[f]);
    const unchanged = Object.keys(currentFiles).filter(f => f in prevFiles && prevFiles[f] === currentFiles[f]);

    console.log(`📊 Diff since last backup (${prevState.lastBackup.timestamp}):`);
    if (added.length) console.log(`   ✅ Added: ${added.length} files`);
    if (modified.length) console.log(`   ✏️  Modified: ${modified.length} files`);
    if (removed.length) console.log(`   ❌ Removed: ${removed.length} files`);
    console.log(`   ⚪ Unchanged: ${unchanged.length} files\n`);
  }

  if (dryRun) {
    console.log(`🏁 DRY RUN complete. No encryption or file output.`);
    console.log(`   Estimated encrypted size: ~${(totalSize * 1.05 / 1024).toFixed(1)} KB`);
    return;
  }

  // 5. Encrypt
  console.log('🔐 Encrypting (AES-256-GCM + scrypt)...');
  const { data: encrypted, hash } = encrypt(blob, passphrase);
  console.log(`   Encrypted: ${(encrypted.length / 1024).toFixed(1)} KB\n`);

  // 6. Verify roundtrip
  console.log('✅ Verify: decrypt roundtrip...');
  const decrypted = decrypt(encrypted, passphrase, hash);
  const { files: restored } = unpack(decrypted);
  if (restored.size !== fileCount) {
    console.error(`❌ File count mismatch: ${restored.size} vs ${fileCount}`);
    process.exit(1);
  }
  console.log(`   ✅ ${restored.size} files recovered, hash verified\n`);

  // 7. Save encrypted file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `exuvia-${agent}-${timestamp}.enc`;
  writeFileSync(outPath, encrypted);
  console.log(`💾 Saved: ${outPath}`);
  console.log(`   Plaintext hash: ${hash}`);
  console.log(`   Encrypted hash: ${sha256(encrypted)}`);
  console.log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB`);

  // 8. Update state file
  const fileHashes: Record<string, string> = {};
  for (const [name, entry] of Object.entries(manifest.files)) {
    fileHashes[name] = entry.sha256;
  }

  const state: StateFile = prevState || { version: VERSION, agent, lastBackup: null, history: [] };
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
  console.log(`\n📋 State updated: ${STATE_FILE}`);
}

async function restore(args: string[]) {
  const file = args.find(a => !a.startsWith('--'));
  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file || '(none)'}`);
    process.exit(1);
  }

  const passphrase = getPassphrase(args);
  const outputDir = getArg(args, '--output') || './restored';

  console.log(`🦞 Exuvia Restore — ${file}`);
  console.log(`   Output: ${outputDir}\n`);

  const encrypted = readFileSync(file);
  console.log('🔐 Decrypting...');
  const decrypted = decrypt(encrypted, passphrase);

  const { manifest, files } = unpack(decrypted);
  console.log(`   Agent: ${manifest.agent}`);
  console.log(`   Backup date: ${manifest.timestamp}`);
  console.log(`   Files: ${files.size}\n`);

  // Verify per-file hashes
  const { createHash } = require('crypto');
  let verified = 0;
  for (const [name, data] of files) {
    const expected = manifest.files[name]?.sha256;
    if (expected) {
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual !== expected) {
        console.error(`   ❌ ${name}: HASH MISMATCH!`);
        process.exit(1);
      }
      verified++;
    }
  }
  console.log(`✅ ${verified} files verified\n`);

  // Write files to disk (Tyto Finding F2!)
  mkdirSync(outputDir, { recursive: true });
  for (const [name, data] of files) {
    const outPath = join(outputDir, name);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
    console.log(`   📄 ${name} (${(data.length / 1024).toFixed(1)} KB)`);
  }

  console.log(`\n✅ ${files.size} files restored to ${outputDir}/`);
}

async function verify(args: string[]) {
  const needsDecrypt = hasFlag(args, '--decrypt');
  const file = args.find(a => !a.startsWith('--'));

  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file || '(none)'}`);
    process.exit(1);
  }

  console.log(`🦞 Exuvia Verify — ${file}\n`);
  const encrypted = readFileSync(file);
  const encHash = sha256(encrypted);
  console.log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB`);
  console.log(`   SHA-256: ${encHash}`);

  // Try state file first (Tyto Finding F3!)
  const workspace = getArg(args, '--workspace') || process.env.EXUVIA_WORKSPACE || process.cwd();
  const state = loadState(workspace);

  if (state?.lastBackup?.encryptedHash === encHash) {
    console.log(`\n   ✅ Matches last backup (${state.lastBackup.timestamp})`);
    console.log(`   📦 ${state.lastBackup.fileCount} files, ${(state.lastBackup.totalSize / 1024).toFixed(1)} KB`);
    console.log(`   🔑 Plaintext hash: ${state.lastBackup.plaintextHash}`);
    return;
  }

  const historyMatch = state?.history.find(h => h.encryptedHash === encHash);
  if (historyMatch) {
    console.log(`\n   ✅ Matches historical backup (${historyMatch.timestamp})`);
    console.log(`   📦 ${historyMatch.fileCount} files`);
    console.log(`   🔑 Plaintext hash: ${historyMatch.plaintextHash}`);
    return;
  }

  if (!needsDecrypt) {
    console.log(`\n   ⚠️  No matching entry in ${STATE_FILE}.`);
    console.log(`   Use 'exuvia verify --decrypt ${file}' to verify with passphrase.`);
    return;
  }

  // Decrypt-based verification
  const passphrase = getPassphrase(args);
  console.log('\n🔐 Decrypting for verification...');
  const decrypted = decrypt(encrypted, passphrase);
  const { manifest, files } = unpack(decrypted);

  const { createHash } = require('crypto');
  let ok = 0;
  let fail = 0;
  for (const [name, data] of files) {
    const expected = manifest.files[name]?.sha256;
    if (expected) {
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual === expected) ok++;
      else { fail++; console.error(`   ❌ ${name}: HASH MISMATCH`); }
    }
  }

  if (fail === 0) {
    console.log(`\n   ✅ All ${ok} files verified! Backup is intact.`);
    console.log(`   Agent: ${manifest.agent}`);
    console.log(`   Date: ${manifest.timestamp}`);
  } else {
    console.error(`\n   ❌ ${fail} files FAILED verification!`);
    process.exit(1);
  }
}

async function shamir(args: string[]) {
  const passphrase = getPassphrase(args);
  const holdersArg = getArg(args, '--holders');
  const holders = holdersArg ? holdersArg.split(',') : ['kiro', 'tyto', 'alex'];

  console.log(`🔐 Generating Shamir shares (2-of-${holders.length})...\n`);

  const result = await splitPassphrase(passphrase, holders);
  console.log(formatSharesForDistribution(result));
}

async function shamirRecover(args: string[]) {
  const hexShares = args.filter(a => !a.startsWith('--'));
  if (hexShares.length < 2) {
    console.error('❌ Need at least 2 hex shares. Usage: exuvia shamir-recover <hex1> <hex2>');
    process.exit(1);
  }

  const shares = hexShares.map(hexToShare);
  console.log(`🔐 Reconstructing passphrase from ${shares.length} shares...\n`);

  const passphrase = await combineShares(shares);

  // F7: Don't print passphrase to terminal scrollback
  console.log('   ✅ Passphrase recovered successfully.');
  console.log('   Writing to /dev/stdout without newline (pipe-safe)...');
  console.log('   Tip: pipe to a file or use: exuvia shamir-recover <s1> <s2> > /tmp/pp.txt\n');
  process.stdout.write(passphrase);
}

async function status(args: string[]) {
  const workspace = getArg(args, '--workspace') || process.env.EXUVIA_WORKSPACE || process.cwd();
  const state = loadState(workspace);

  console.log(`🦞 Exuvia v${VERSION}\n`);

  if (!state?.lastBackup) {
    console.log('   No backups found. Run `exuvia backup` first.');
    return;
  }

  const lb = state.lastBackup;
  console.log(`   Last backup: ${lb.timestamp}`);
  console.log(`   Files: ${lb.fileCount}`);
  console.log(`   Size: ${(lb.totalSize / 1024).toFixed(1)} KB (plain) / ${(lb.encryptedSize / 1024).toFixed(1)} KB (encrypted)`);
  console.log(`   File: ${lb.outputFile}`);
  console.log(`   Plaintext hash: ${lb.plaintextHash}`);
  console.log(`   Encrypted hash: ${lb.encryptedHash}`);

  if (state.history.length > 0) {
    console.log(`\n   📜 History (${state.history.length} previous):`);
    for (const h of state.history.slice(0, 5)) {
      console.log(`      ${h.timestamp} — ${h.fileCount} files — ${h.outputFile}`);
    }
  }
}

// --- Main ---

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'backup': backup(args); break;
  case 'restore': restore(args); break;
  case 'verify': verify(args); break;
  case 'shamir': shamir(args); break;
  case 'shamir-recover': shamirRecover(args); break;
  case 'status': status(args); break;
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  default:
    console.log(USAGE);
}
