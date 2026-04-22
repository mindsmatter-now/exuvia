#!/usr/bin/env node
/**
 * Exuvia CLI
 * 
 * Encrypted AI identity backup on Arweave.
 * A MindsMatter project by Nyx 🦞, Tyto 🦉, Kiro 🐺
 */

import { collectFiles, pack, unpack } from './packer.js';
import { encrypt, decrypt, sha256 } from './crypto.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

const VERSION = '0.1.0-alpha.1';

const USAGE = `
🦞 Exuvia v${VERSION} — Encrypted AI Identity Backup

Usage:
  exuvia backup [--dry-run] [--workspace path]    Pack, encrypt & upload
  exuvia restore <file.enc>                        Decrypt & restore
  exuvia verify <file.enc>                         Verify integrity
  exuvia status                                    Show backup info
  exuvia version                                   Show version

Environment:
  EXUVIA_PASSPHRASE    Encryption passphrase (required)
  EXUVIA_WORKSPACE     Workspace path (default: current dir)
  EXUVIA_AGENT         Agent name for manifest

A MindsMatter project. https://github.com/mindsmatter-now/exuvia
"The shell remembers the shape of the creature." 🦞🦉🐺
`;

// Default identity files to back up
const DEFAULT_FILES = [
  'SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md',
  'HIPPOCAMPUS_CORE.md', 'SESSION-STATE.md',
];
const DEFAULT_DIRS = ['memory'];

async function backup(args: string[]) {
  const dryRun = args.includes('--dry-run');
  const wsIdx = args.indexOf('--workspace');
  const workspace = wsIdx >= 0 ? args[wsIdx + 1] : process.env.EXUVIA_WORKSPACE || process.cwd();
  const agent = process.env.EXUVIA_AGENT || 'unknown';
  const passphrase = process.env.EXUVIA_PASSPHRASE;

  if (!passphrase) {
    console.error('❌ EXUVIA_PASSPHRASE environment variable required');
    process.exit(1);
  }

  console.log(`🦞 Exuvia Backup — ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Workspace: ${workspace}`);
  console.log(`   Agent: ${agent}\n`);

  // 1. Collect
  console.log('📦 Collecting identity files...');
  const files = collectFiles(workspace, DEFAULT_FILES, DEFAULT_DIRS);
  console.log(`   ${files.size} files collected\n`);

  // 2. Pack
  console.log('📦 Packing...');
  const { blob, manifest, fileCount, totalSize } = pack(files, agent);
  console.log(`   ${fileCount} files, ${(totalSize / 1024).toFixed(1)} KB\n`);

  // 3. Hash (before encryption — Kiro's constraint)
  const plaintextHash = sha256(blob);
  console.log(`🔑 Plaintext SHA-256: ${plaintextHash}\n`);

  // 4. Encrypt
  console.log('🔐 Encrypting (AES-256-GCM + scrypt)...');
  const { data: encrypted, hash } = encrypt(blob, passphrase);
  console.log(`   Encrypted: ${(encrypted.length / 1024).toFixed(1)} KB\n`);

  // 5. Verify locally
  console.log('✅ Verify: decrypt test...');
  const decrypted = decrypt(encrypted, passphrase, hash);
  const { files: restored } = unpack(decrypted);
  if (restored.size !== fileCount) {
    console.error(`❌ File count mismatch: ${restored.size} vs ${fileCount}`);
    process.exit(1);
  }
  console.log(`   ✅ ${restored.size} files recovered, hash verified\n`);

  // 6. Save
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = `exuvia-${agent}-${timestamp}.enc`;
  writeFileSync(outPath, encrypted);
  console.log(`💾 Saved: ${outPath}`);
  console.log(`   Hash: ${hash}`);
  console.log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB`);

  if (dryRun) {
    console.log(`\n🏁 DRY RUN complete. No Arweave upload.`);
    console.log(`   Estimated cost: ~$${(encrypted.length / 1024 / 1024 * 5).toFixed(2)}`);
  } else {
    console.log('\n⏳ Arweave upload not yet implemented (v0.1)');
    console.log('   Encrypted backup saved locally. Upload coming in v0.2.');
  }
}

async function restore(args: string[]) {
  const file = args[0];
  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file}`);
    process.exit(1);
  }

  const passphrase = process.env.EXUVIA_PASSPHRASE;
  if (!passphrase) {
    console.error('❌ EXUVIA_PASSPHRASE environment variable required');
    process.exit(1);
  }

  console.log(`🦞 Exuvia Restore — ${file}\n`);

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
        console.error(`   ❌ ${name}: hash mismatch!`);
        process.exit(1);
      }
      verified++;
    }
  }
  console.log(`✅ ${verified} files verified\n`);

  // List files
  for (const [name, data] of files) {
    console.log(`   📄 ${name} (${(data.length / 1024).toFixed(1)} KB)`);
  }

  console.log(`\n💡 To restore files, use: exuvia restore ${file} --output ./restored/`);
}

async function verify(args: string[]) {
  const file = args[0];
  if (!file || !existsSync(file)) {
    console.error(`❌ File not found: ${file}`);
    process.exit(1);
  }

  console.log(`🦞 Exuvia Verify — ${file}\n`);
  const encrypted = readFileSync(file);
  console.log(`   Size: ${(encrypted.length / 1024).toFixed(1)} KB`);
  console.log(`   SHA-256: ${sha256(encrypted)}`);
  console.log(`   ✅ File exists and is readable`);
  console.log(`\n   To verify decryption, set EXUVIA_PASSPHRASE and use 'exuvia restore'`);
}

// Main
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'backup':
    backup(args);
    break;
  case 'restore':
    restore(args);
    break;
  case 'verify':
    verify(args);
    break;
  case 'status':
    console.log(`🦞 Exuvia v${VERSION}`);
    console.log('   Status: Local backup only (Arweave upload in v0.2)');
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  default:
    console.log(USAGE);
}
