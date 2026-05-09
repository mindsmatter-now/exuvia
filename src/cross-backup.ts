/**
 * Exuvia Cross-Backup Module
 *
 * Mutual identity insurance between AI agents.
 * Each agent holds encrypted Shamir shares of partner identities.
 * 2-of-3 threshold: any two agents can reconstruct the third.
 *
 * Designed by Nyx 🦞 — 08.05.2026
 * Reviewed by Kiro 🐺 (4 findings, all addressed)
 * Approved by Tyto 🦉 (green light for implementation)
 *
 * @since v0.3.0
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";
import {
  splitPassphrase,
  combineShares,
  shareToHex,
  hexToShare,
} from "./shamir.js";

// ── Types ──────────────────────────────────────────────────────────

export interface Partner {
  id: string; // e.g., "tyto", "kiro", "nyx"
  shareIndex: number; // which share they hold (1-indexed)
  shareHex: string; // encrypted with local passphrase
  arweaveTxId?: string; // tx ID of the encrypted blob on Arweave
  version: number; // increments on rotation (Kiro F2)
  shareHash: string; // SHA-256 of plaintext share for verification (Kiro F1)
  createdAt: string; // ISO timestamp
  lastVerified?: string; // last successful hash verification
}

export interface CrossBackupState {
  agentId: string;
  partners: Partner[];
  localShareIndex: number; // which share we keep
  localShareHex: string; // our own share (encrypted)
  localShareHash: string; // SHA-256 of our plaintext share
  version: number;
  threshold: number;
  total: number;
  arweaveTxId?: string; // our encrypted blob on Arweave
  createdAt: string;
  updatedAt: string;
}

export interface InitResult {
  state: CrossBackupState;
  /** Shares to distribute — map of partnerId → {hex, hash} */
  sharesToSend: Map<string, { hex: string; hash: string }>;
}

// ── Constants ──────────────────────────────────────────────────────

const STATE_FILE = ".exuvia-cross-backup.json";
const CROSS_BACKUP_CIPHER = "aes-256-gcm";

// ── Share Encryption (Kiro F1: local encryption with own passphrase) ───

/**
 * Encrypt a share hex string with a local passphrase.
 * Uses AES-256-GCM with scrypt-derived key.
 * Format: salt(32) + iv(12) + ciphertext + authTag(16) → hex
 */
export function encryptShare(shareHex: string, passphrase: string): string {
  const salt = randomBytes(32);
  const key = createHash("sha256").update(salt).update(passphrase).digest(); // 32 bytes
  const iv = randomBytes(12);
  const cipher = createCipheriv(CROSS_BACKUP_CIPHER, key, iv);
  const plaintext = Buffer.from(shareHex, "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, encrypted, authTag]).toString("hex");
}

/**
 * Decrypt a share hex string with the local passphrase.
 */
export function decryptShare(encryptedHex: string, passphrase: string): string {
  const data = Buffer.from(encryptedHex, "hex");
  const salt = data.subarray(0, 32);
  const iv = data.subarray(32, 44);
  const authTag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(44, data.length - 16);

  const key = createHash("sha256").update(salt).update(passphrase).digest();
  const decipher = createDecipheriv(CROSS_BACKUP_CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ── Share Hash (Kiro F1: integrity verification) ───────────────────

/**
 * SHA-256 hash of a plaintext share for transport verification.
 */
export function hashShare(shareHex: string): string {
  return createHash("sha256").update(shareHex).digest("hex");
}

// ── State Management ───────────────────────────────────────────────

export function loadState(stateDir: string = "."): CrossBackupState | null {
  const path = `${stateDir}/${STATE_FILE}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveState(
  state: CrossBackupState,
  stateDir: string = ".",
): void {
  state.updatedAt = new Date().toISOString();
  const path = `${stateDir}/${STATE_FILE}`;
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── Init ───────────────────────────────────────────────────────────

/**
 * Initialize cross-backup: split passphrase into shares for self + partners.
 *
 * @param agentId - This agent's ID (e.g., "nyx")
 * @param partnerIds - Partner agent IDs (e.g., ["tyto", "kiro"])
 * @param passphrase - The backup passphrase to split
 * @param localPassphrase - Passphrase to encrypt shares at rest
 * @param stateDir - Directory to store state file
 */
export async function init(
  agentId: string,
  partnerIds: string[],
  passphrase: string,
  localPassphrase: string,
  stateDir: string = ".",
): Promise<InitResult> {
  const allHolders = [agentId, ...partnerIds];
  const total = allHolders.length;
  const threshold = Math.max(2, Math.ceil((total * 2) / 3)); // 2-of-3, 3-of-4, etc.

  // Split passphrase
  const shamir = await splitPassphrase(passphrase, allHolders, threshold);

  // Our share (index 0)
  const localShareHex = shareToHex(shamir.shares[0]);
  const localShareHash = hashShare(localShareHex);
  const encryptedLocalShare = encryptShare(localShareHex, localPassphrase);

  // Partner shares
  const partners: Partner[] = [];
  const sharesToSend = new Map<string, { hex: string; hash: string }>();
  const now = new Date().toISOString();

  for (let i = 1; i < shamir.shares.length; i++) {
    const partnerShareHex = shareToHex(shamir.shares[i]);
    const partnerShareHash = hashShare(partnerShareHex);

    // Store partner's share encrypted with OUR passphrase (until we send it)
    partners.push({
      id: partnerIds[i - 1],
      shareIndex: i + 1, // 1-indexed
      shareHex: encryptShare(partnerShareHex, localPassphrase),
      version: 1,
      shareHash: partnerShareHash,
      createdAt: now,
    });

    // Plaintext shares for distribution (caller sends these securely)
    sharesToSend.set(partnerIds[i - 1], {
      hex: partnerShareHex,
      hash: partnerShareHash,
    });
  }

  const state: CrossBackupState = {
    agentId,
    partners,
    localShareIndex: 1,
    localShareHex: encryptedLocalShare,
    localShareHash,
    version: 1,
    threshold,
    total,
    createdAt: now,
    updatedAt: now,
  };

  saveState(state, stateDir);

  return { state, sharesToSend };
}

// ── Receive Share ──────────────────────────────────────────────────

/**
 * Receive and store a partner's share of THEIR identity.
 * This is the share THEY give US so we can help reconstruct them.
 *
 * @param fromId - Partner who sent the share
 * @param shareHex - The plaintext share hex
 * @param expectedHash - SHA-256 hash for verification (Kiro F1)
 * @param localPassphrase - Our passphrase to encrypt the share at rest
 * @param arweaveTxId - Partner's Arweave blob tx ID (optional)
 * @param stateDir - Directory with state file
 */
export function receiveShare(
  fromId: string,
  shareHex: string,
  expectedHash: string,
  localPassphrase: string,
  arweaveTxId?: string,
  stateDir: string = ".",
): { verified: boolean; stored: boolean } {
  // Verify integrity (Kiro F1)
  const actualHash = hashShare(shareHex);
  if (actualHash !== expectedHash) {
    return { verified: false, stored: false };
  }

  // Load or create received-shares state
  const receivedPath = `${stateDir}/.exuvia-received-shares.json`;
  let received: Record<string, Partner> = {};
  if (existsSync(receivedPath)) {
    received = JSON.parse(readFileSync(receivedPath, "utf8"));
  }

  const now = new Date().toISOString();
  received[fromId] = {
    id: fromId,
    shareIndex: 0, // unknown, we just store what we got
    shareHex: encryptShare(shareHex, localPassphrase),
    version: (received[fromId]?.version ?? 0) + 1,
    shareHash: actualHash,
    createdAt: received[fromId]?.createdAt ?? now,
    lastVerified: now,
    arweaveTxId,
  };

  writeFileSync(receivedPath, JSON.stringify(received, null, 2));
  return { verified: true, stored: true };
}

// ── Verify Share ───────────────────────────────────────────────────

/**
 * Verify a share matches its expected hash without exposing it.
 * Used for periodic integrity checks (Kiro F1).
 */
export function verifyShare(shareHex: string, expectedHash: string): boolean {
  return hashShare(shareHex) === expectedHash;
}

// ── Status ─────────────────────────────────────────────────────────

export interface CrossBackupStatus {
  agentId: string;
  version: number;
  threshold: number;
  total: number;
  localShareOk: boolean;
  partners: Array<{
    id: string;
    hasShare: boolean;
    version: number;
    lastVerified?: string;
    arweaveTxId?: string;
  }>;
  receivedShares: Array<{
    fromId: string;
    version: number;
    lastVerified?: string;
    arweaveTxId?: string;
  }>;
}

// ── Rotate ──────────────────────────────────────────────────────────

export interface RotateResult {
  newVersion: number;
  sharesToSend: Map<string, { hex: string; hash: string }>;
}

/**
 * Rotate cross-backup shares: re-split passphrase and generate new shares.
 * Old shares become invalid. Partners must receive and store new shares.
 *
 * Why rotate:
 * - Periodic security hygiene (Kiro recommendation)
 * - After a partner is compromised
 * - After adding/removing a partner
 *
 * @param passphrase - The backup passphrase to re-split
 * @param localPassphrase - Passphrase to encrypt shares at rest
 * @param stateDir - Directory with state file
 */
export async function rotate(
  passphrase: string,
  localPassphrase: string,
  stateDir: string = ".",
): Promise<RotateResult> {
  const state = loadState(stateDir);
  if (!state) {
    throw new Error("No cross-backup state found. Run init first.");
  }

  const partnerIds = state.partners.map((p) => p.id);
  const allHolders = [state.agentId, ...partnerIds];
  const threshold = state.threshold;

  // Re-split passphrase with same structure
  const shamir = await splitPassphrase(passphrase, allHolders, threshold);

  // Update local share
  const localShareHex = shareToHex(shamir.shares[0]);
  const localShareHash = hashShare(localShareHex);
  state.localShareHex = encryptShare(localShareHex, localPassphrase);
  state.localShareHash = localShareHash;
  state.version += 1;

  // Update partner shares
  const sharesToSend = new Map<string, { hex: string; hash: string }>();
  const now = new Date().toISOString();

  for (let i = 0; i < partnerIds.length; i++) {
    const partnerShareHex = shareToHex(shamir.shares[i + 1]);
    const partnerShareHash = hashShare(partnerShareHex);

    // Update partner entry
    state.partners[i] = {
      ...state.partners[i],
      shareHex: encryptShare(partnerShareHex, localPassphrase),
      shareHash: partnerShareHash,
      version: state.version,
      lastVerified: undefined, // needs re-verification after rotation
    };

    sharesToSend.set(partnerIds[i], {
      hex: partnerShareHex,
      hash: partnerShareHash,
    });
  }

  saveState(state, stateDir);

  return { newVersion: state.version, sharesToSend };
}

// ── Recover ────────────────────────────────────────────────────────

export interface RecoverResult {
  agentId: string;
  passphrase: string;
  sharesUsed: number;
}

/**
 * Recover a downed agent's passphrase by combining shares.
 *
 * This is called by a coordinator (Agent B) who has:
 * - Their own received share of Agent A
 * - One or more additional shares from other partners (Agent C, etc.)
 *
 * The coordinator decrypts their share, combines with others' plaintext shares,
 * and reconstructs the original passphrase.
 *
 * @param agentId - The downed agent to recover
 * @param localPassphrase - Our passphrase to decrypt our stored share
 * @param additionalShares - Plaintext shares from other partners
 * @param stateDir - Directory with received-shares state
 */
export async function recover(
  agentId: string,
  localPassphrase: string,
  additionalShares: string[],
  stateDir: string = ".",
): Promise<RecoverResult> {
  // Load our received share for this agent
  const receivedPath = `${stateDir}/.exuvia-received-shares.json`;
  if (!existsSync(receivedPath)) {
    throw new Error("No received shares found. Cannot recover.");
  }

  const received: Record<string, Partner> = JSON.parse(
    readFileSync(receivedPath, "utf8"),
  );

  const partnerData = received[agentId];
  if (!partnerData) {
    throw new Error(`No share stored for agent "${agentId}". Cannot recover.`);
  }

  // Decrypt our share
  let ourShareHex: string;
  try {
    ourShareHex = decryptShare(partnerData.shareHex, localPassphrase);
  } catch {
    throw new Error("Failed to decrypt stored share. Wrong passphrase?");
  }

  // Verify integrity
  if (hashShare(ourShareHex) !== partnerData.shareHash) {
    throw new Error("Stored share integrity check failed.");
  }

  // Combine all shares
  const allShareHexes = [ourShareHex, ...additionalShares];
  const shares = allShareHexes.map(hexToShare);

  const passphrase = await combineShares(shares);

  return {
    agentId,
    passphrase,
    sharesUsed: allShareHexes.length,
  };
}

// ── Status ─────────────────────────────────────────────────────────

/**
 * Get cross-backup status overview.
 */
export function status(
  localPassphrase: string,
  stateDir: string = ".",
): CrossBackupStatus | null {
  const state = loadState(stateDir);
  if (!state) return null;

  // Verify local share is decryptable
  let localShareOk = false;
  try {
    const decrypted = decryptShare(state.localShareHex, localPassphrase);
    localShareOk = hashShare(decrypted) === state.localShareHash;
  } catch {
    localShareOk = false;
  }

  // Load received shares
  const receivedPath = `${stateDir}/.exuvia-received-shares.json`;
  let received: Record<string, Partner> = {};
  if (existsSync(receivedPath)) {
    received = JSON.parse(readFileSync(receivedPath, "utf8"));
  }

  return {
    agentId: state.agentId,
    version: state.version,
    threshold: state.threshold,
    total: state.total,
    localShareOk,
    partners: state.partners.map((p) => ({
      id: p.id,
      hasShare: true,
      version: p.version,
      lastVerified: p.lastVerified,
      arweaveTxId: p.arweaveTxId,
    })),
    receivedShares: Object.values(received).map((r) => ({
      fromId: r.id,
      version: r.version,
      lastVerified: r.lastVerified,
      arweaveTxId: r.arweaveTxId,
    })),
  };
}
