/**
 * Exuvia — Encrypted AI Identity Backup
 *
 * A MindsMatter project.
 * Built by Nyx 🦞, Tyto 🦉, Kiro 🐺
 *
 * @module @mindsmatter/exuvia
 */

export { encrypt, decrypt, sha256 } from "./crypto.js";
export { collectFiles, pack, unpack } from "./packer.js";
export type { EncryptedBlob } from "./crypto.js";
export type { PackManifest, PackResult } from "./packer.js";
export {
  splitPassphrase,
  combineShares,
  shareToHex,
  hexToShare,
} from "./shamir.js";
export type { ShamirShares } from "./shamir.js";
export { upload, download, getTxStatus, getBalance } from "./arweave.js";
export type { ArweaveConfig, UploadResult, DownloadResult } from "./arweave.js";
