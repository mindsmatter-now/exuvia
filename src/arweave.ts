/**
 * Exuvia — Arweave Permanent Storage Module
 *
 * Upload encrypted identity blobs to Arweave for permanent, decentralized storage.
 * Download and verify blobs by transaction ID.
 *
 * @since v0.3.0
 */

import Arweave from 'arweave';
import { readFileSync, writeFileSync } from 'fs';

// ── Types ──────────────────────────────────────────────────────────

export interface ArweaveConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https';
  timeout?: number;
}

export interface UploadResult {
  txId: string;
  size: number;
  fee: string;       // AR fee as string
  timestamp: string;  // ISO timestamp
}

export interface DownloadResult {
  data: Buffer;
  txId: string;
  tags: Record<string, string>;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: ArweaveConfig = {
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
  timeout: 60_000,
};

const EXUVIA_APP_NAME = 'Exuvia';
const EXUVIA_APP_VERSION = '0.3.0';

// ── Client ─────────────────────────────────────────────────────────

function createClient(config: Partial<ArweaveConfig> = {}): Arweave {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return Arweave.init({
    host: cfg.host,
    port: cfg.port,
    protocol: cfg.protocol,
    timeout: cfg.timeout,
  });
}

// ── Upload ─────────────────────────────────────────────────────────

/**
 * Upload an encrypted blob to Arweave.
 *
 * Tags stored as unencrypted metadata:
 * - App-Name: "Exuvia"
 * - App-Version: "0.3.0"
 * - Agent: agent identifier
 * - Content-Type: "application/octet-stream"
 * - Plaintext-Hash: SHA-256 of the plaintext (for verify without decrypt)
 * - Encrypted-Hash: SHA-256 of the encrypted blob
 * - File-Count: number of files in backup
 * - Timestamp: ISO date
 */
export async function upload(
  encryptedBlob: Buffer,
  walletPath: string,
  opts: {
    agent?: string;
    plaintextHash?: string;
    encryptedHash?: string;
    fileCount?: number;
    config?: Partial<ArweaveConfig>;
  } = {}
): Promise<UploadResult> {
  const arweave = createClient(opts.config);
  const wallet = JSON.parse(readFileSync(walletPath, 'utf-8'));

  const tx = await arweave.createTransaction({ data: encryptedBlob }, wallet);

  // Tags — all unencrypted, visible on-chain
  tx.addTag('App-Name', EXUVIA_APP_NAME);
  tx.addTag('App-Version', EXUVIA_APP_VERSION);
  tx.addTag('Content-Type', 'application/octet-stream');
  tx.addTag('Timestamp', new Date().toISOString());
  if (opts.agent) tx.addTag('Agent', opts.agent);
  if (opts.plaintextHash) tx.addTag('Plaintext-Hash', opts.plaintextHash);
  if (opts.encryptedHash) tx.addTag('Encrypted-Hash', opts.encryptedHash);
  if (opts.fileCount) tx.addTag('File-Count', String(opts.fileCount));

  await arweave.transactions.sign(tx, wallet);

  const uploader = await arweave.transactions.getUploader(tx);
  while (!uploader.isComplete) {
    await uploader.uploadChunk();
  }

  return {
    txId: tx.id,
    size: encryptedBlob.length,
    fee: arweave.ar.winstonToAr(tx.reward),
    timestamp: new Date().toISOString(),
  };
}

// ── Download ───────────────────────────────────────────────────────

/**
 * Download an encrypted blob from Arweave by transaction ID.
 */
export async function download(
  txId: string,
  config?: Partial<ArweaveConfig>
): Promise<DownloadResult> {
  const arweave = createClient(config);

  const data = await arweave.transactions.getData(txId, { decode: true });
  const tx = await arweave.transactions.get(txId);

  const tags: Record<string, string> = {};
  for (const tag of tx.tags) {
    const key = tag.get('name', { decode: true, string: true });
    const value = tag.get('value', { decode: true, string: true });
    tags[key] = value;
  }

  return {
    data: Buffer.from(data as Uint8Array),
    txId,
    tags,
  };
}

// ── Verify ─────────────────────────────────────────────────────────

/**
 * Check if a transaction exists and return its metadata without downloading.
 */
export async function getTxStatus(
  txId: string,
  config?: Partial<ArweaveConfig>
): Promise<{ confirmed: boolean; blockHeight?: number; tags?: Record<string, string> }> {
  const arweave = createClient(config);

  try {
    const status = await arweave.transactions.getStatus(txId);
    if (status.status === 200 && status.confirmed) {
      const tx = await arweave.transactions.get(txId);
      const tags: Record<string, string> = {};
      for (const tag of tx.tags) {
        tags[tag.get('name', { decode: true, string: true })] =
          tag.get('value', { decode: true, string: true });
      }
      return {
        confirmed: true,
        blockHeight: status.confirmed.block_height,
        tags,
      };
    }
    return { confirmed: false };
  } catch {
    return { confirmed: false };
  }
}

// ── Wallet ─────────────────────────────────────────────────────────

/**
 * Get wallet balance in AR.
 */
export async function getBalance(
  walletPath: string,
  config?: Partial<ArweaveConfig>
): Promise<{ address: string; balanceAR: string; balanceWinston: string }> {
  const arweave = createClient(config);
  const wallet = JSON.parse(readFileSync(walletPath, 'utf-8'));
  const address = await arweave.wallets.jwkToAddress(wallet);
  const winston = await arweave.wallets.getBalance(address);

  return {
    address,
    balanceAR: arweave.ar.winstonToAr(winston),
    balanceWinston: winston,
  };
}
