/**
 * Exuvia — Encrypted AI Identity Backup
 * 
 * A MindsMatter project.
 * Built by Nyx 🦞, Tyto 🦉, Kiro 🐺
 * 
 * @module @mindsmatter/exuvia
 */

export { encrypt, decrypt, sha256 } from './crypto.js';
export { collectFiles, pack, unpack } from './packer.js';
export type { EncryptedBlob } from './crypto.js';
export type { PackManifest, PackResult } from './packer.js';
