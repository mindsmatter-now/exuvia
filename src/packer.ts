/**
 * Exuvia Packer Module
 * 
 * Collects and packs identity files into a single blob.
 * Architecture by Tyto 🦉
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

export interface PackManifest {
  version: string;
  agent: string;
  timestamp: string;
  files: Record<string, { offset: number; length: number; sha256: string }>;
}

export interface PackResult {
  blob: Buffer;
  manifest: PackManifest;
  fileCount: number;
  totalSize: number;
}

// Security: never include these patterns
const DEFAULT_EXCLUDES = [
  '.env', 'secret', 'key', 'token', 'password', 'credential',
  'wallet.json', '.ssh', 'auth-profiles', 'node_modules', '.git',
];

function isExcluded(filePath: string, excludes: string[]): boolean {
  const lower = filePath.toLowerCase();
  return excludes.some(p => lower.includes(p.toLowerCase()));
}

function isPathSafe(filePath: string): boolean {
  // Guard against path traversal
  const normalized = filePath.replace(/\\/g, '/');
  return !normalized.includes('..') && !normalized.startsWith('/');
}

function walkDir(dir: string, basePath: string, excludes: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = join(basePath, entry.name);

    if (isExcluded(relPath, excludes) || !isPathSafe(relPath)) continue;

    if (entry.isDirectory()) {
      const subFiles = walkDir(fullPath, relPath, excludes);
      for (const [k, v] of subFiles) files.set(k, v);
    } else if (entry.isFile()) {
      files.set(relPath, readFileSync(fullPath));
    }
  }
  return files;
}

/**
 * Collect identity files from workspace
 */
export function collectFiles(
  workspace: string,
  includeFiles: string[],
  includeDirs: string[],
  excludes: string[] = DEFAULT_EXCLUDES
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();

  // Individual files
  for (const f of includeFiles) {
    const fullPath = join(workspace, f);
    if (existsSync(fullPath) && !isExcluded(f, excludes)) {
      files.set(f, readFileSync(fullPath));
    }
  }

  // Directories (recursive)
  for (const dir of includeDirs) {
    const dirFiles = walkDir(join(workspace, dir), dir, excludes);
    for (const [k, v] of dirFiles) files.set(k, v);
  }

  return files;
}

/**
 * Pack files into a single blob with manifest
 */
export function pack(files: Map<string, Buffer>, agentName: string): PackResult {
  const { createHash } = require('crypto');
  const manifest: PackManifest = {
    version: '0.1.0',
    agent: agentName,
    timestamp: new Date().toISOString(),
    files: {},
  };

  const buffers: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of files) {
    const hash = createHash('sha256').update(data).digest('hex');
    manifest.files[name] = { offset, length: data.length, sha256: hash };
    buffers.push(data);
    offset += data.length;
  }

  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const manifestLen = Buffer.alloc(4);
  manifestLen.writeUInt32BE(manifestBuf.length);

  // Format: [manifestLength:4][manifest:JSON][file1][file2]...
  const blob = Buffer.concat([manifestLen, manifestBuf, ...buffers]);

  return {
    blob,
    manifest,
    fileCount: files.size,
    totalSize: offset,
  };
}

/**
 * Unpack blob back into files
 */
export function unpack(blob: Buffer): { manifest: PackManifest; files: Map<string, Buffer> } {
  const manifestLen = blob.readUInt32BE(0);
  const manifest: PackManifest = JSON.parse(blob.subarray(4, 4 + manifestLen).toString());
  const dataStart = 4 + manifestLen;

  const files = new Map<string, Buffer>();
  for (const [name, { offset, length }] of Object.entries(manifest.files)) {
    if (!isPathSafe(name)) {
      throw new Error(`Path traversal detected in archive: ${name}`);
    }
    files.set(name, blob.subarray(dataStart + offset, dataStart + offset + length));
  }

  return { manifest, files };
}
