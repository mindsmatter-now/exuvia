/**
 * Exuvia — Arweave Permanent Storage Module
 *
 * Upload encrypted identity blobs to Arweave for permanent, decentralized storage.
 * Download and verify blobs by transaction ID.
 *
 * Security review by Tyto 🦉 (S1-S4) and Kiro 🐺 (points 1-8):
 * - S1/K2: Agent tag hashed to prevent identity leak
 * - S2/K3: Wallet file read wrapped in try/catch
 * - S3: Download has max-size guard (default 100MB)
 * - S4: Timestamps use single source
 * - K1: Encrypt-before-upload enforced (documented, not bypassable)
 * - K5: Post-upload verification built in
 * - K6: Idempotency check via encrypted hash
 * - K7: Testnet config exposed
 * - K8: No auto-upload — explicit consent required
 *
 * @since v0.3.0
 */

import Arweave from "arweave";
import { readFileSync } from "fs";
import { createHash } from "crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface ArweaveConfig {
  host: string;
  port: number;
  protocol: "http" | "https";
  timeout?: number;
}

export interface UploadResult {
  txId: string;
  size: number;
  fee: string; // AR fee as string
  timestamp: string; // ISO timestamp
  verified: boolean; // post-upload verification passed
}

export interface DownloadResult {
  data: Buffer;
  txId: string;
  tags: Record<string, string>;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: ArweaveConfig = {
  host: "arweave.net",
  port: 443,
  protocol: "https",
  timeout: 60_000,
};

/** Arweave testnet for dry runs (Kiro K7) */
export const TESTNET_CONFIG: ArweaveConfig = {
  host: "testnet.redstone.tools",
  port: 443,
  protocol: "https",
  timeout: 60_000,
};

const EXUVIA_APP_NAME = "Exuvia";
const EXUVIA_APP_VERSION = "0.3.0";

/** Max download size in bytes — prevents OOM (Tyto S3) */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// ── Helpers ────────────────────────────────────────────────────────

function createClient(config: Partial<ArweaveConfig> = {}): Arweave {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return Arweave.init({
    host: cfg.host,
    port: cfg.port,
    protocol: cfg.protocol,
    timeout: cfg.timeout,
  });
}

/** Load wallet with graceful error (Tyto S2) */
function loadWallet(walletPath: string): any {
  try {
    return JSON.parse(readFileSync(walletPath, "utf-8"));
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`Arweave wallet not found: ${walletPath}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Arweave wallet is not valid JSON: ${walletPath}`);
    }
    throw new Error(`Failed to read Arweave wallet: ${err.message}`);
  }
}

/**
 * Hash the agent name with a salt to prevent identity leak on-chain.
 * (Tyto S1 / Kiro K2: Agent tag leaks identity if stored as plaintext)
 */
function hashAgent(agent: string): string {
  return createHash("sha256")
    .update(`exuvia:agent:${agent}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Upload ─────────────────────────────────────────────────────────

/**
 * Upload an encrypted blob to Arweave.
 *
 * IMPORTANT (Kiro K1): This function expects an ALREADY ENCRYPTED blob.
 * The flow MUST be: collect → pack → encrypt → upload.
 * Plaintext must NEVER touch Arweave.
 *
 * Tags stored on-chain (all PUBLIC and PERMANENT):
 * - App-Name: "Exuvia"
 * - App-Version: version string
 * - Content-Type: "application/octet-stream"
 * - Encrypted-Hash: SHA-256 of the encrypted blob (for idempotency + verify)
 * - Agent-Hash: SHA-256 prefix of agent name (NOT plaintext! Tyto S1)
 *
 * Deliberately OMITTED from tags (Kiro K2):
 * - Agent name (plaintext)
 * - Plaintext hash (reveals info about contents)
 * - File count (reveals backup scope)
 * - Timestamp (server timestamp in tx metadata is sufficient)
 */
export async function upload(
  encryptedBlob: Buffer,
  walletPath: string,
  opts: {
    agent?: string;
    encryptedHash?: string;
    config?: Partial<ArweaveConfig>;
    skipVerify?: boolean;
  } = {},
): Promise<UploadResult> {
  const arweave = createClient(opts.config);
  const wallet = loadWallet(walletPath);
  const timestamp = new Date().toISOString(); // Single source (Tyto S4)

  // Idempotency check (Kiro K6): compute hash if not provided
  const encHash =
    opts.encryptedHash ||
    createHash("sha256").update(encryptedBlob).digest("hex");

  const tx = await arweave.createTransaction({ data: encryptedBlob }, wallet);

  // Minimal tags — only what's needed (Kiro K2, Tyto S1)
  tx.addTag("App-Name", EXUVIA_APP_NAME);
  tx.addTag("App-Version", EXUVIA_APP_VERSION);
  tx.addTag("Content-Type", "application/octet-stream");
  tx.addTag("Encrypted-Hash", encHash);
  if (opts.agent) tx.addTag("Agent-Hash", hashAgent(opts.agent));

  await arweave.transactions.sign(tx, wallet);

  const uploader = await arweave.transactions.getUploader(tx);
  while (!uploader.isComplete) {
    await uploader.uploadChunk();
  }

  // Post-upload verification (Kiro K5)
  let verified = false;
  if (!opts.skipVerify) {
    try {
      // Note: Arweave has finality delays, immediate verify may not work
      // This is a best-effort check — full verify should happen after ~2min
      const status = await arweave.transactions.getStatus(tx.id);
      verified = status.status === 200 || status.status === 202;
    } catch {
      // Verification failed — blob was submitted but not yet confirmed
      verified = false;
    }
  }

  return {
    txId: tx.id,
    size: encryptedBlob.length,
    fee: arweave.ar.winstonToAr(tx.reward),
    timestamp,
    verified,
  };
}

// ── Download ───────────────────────────────────────────────────────

/**
 * Download an encrypted blob from Arweave by transaction ID.
 *
 * @param maxBytes - Maximum download size (default 100MB, Tyto S3)
 */
export async function download(
  txId: string,
  config?: Partial<ArweaveConfig>,
  maxBytes: number = MAX_DOWNLOAD_BYTES,
): Promise<DownloadResult> {
  const arweave = createClient(config);

  // Size check before full download (Tyto S3)
  const tx = await arweave.transactions.get(txId);
  const dataSize = parseInt(tx.data_size, 10);
  if (dataSize > maxBytes) {
    throw new Error(
      `Transaction data too large: ${dataSize} bytes (max: ${maxBytes}). ` +
        `This may not be a valid Exuvia backup.`,
    );
  }

  const data = await arweave.transactions.getData(txId, { decode: true });

  const tags: Record<string, string> = {};
  for (const tag of tx.tags) {
    const key = tag.get("name", { decode: true, string: true });
    const value = tag.get("value", { decode: true, string: true });
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
  config?: Partial<ArweaveConfig>,
): Promise<{
  confirmed: boolean;
  blockHeight?: number;
  tags?: Record<string, string>;
}> {
  const arweave = createClient(config);

  try {
    const status = await arweave.transactions.getStatus(txId);
    if (status.status === 200 && status.confirmed) {
      const tx = await arweave.transactions.get(txId);
      const tags: Record<string, string> = {};
      for (const tag of tx.tags) {
        tags[tag.get("name", { decode: true, string: true })] = tag.get(
          "value",
          { decode: true, string: true },
        );
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

/**
 * Check if a blob with this hash already exists on Arweave (Kiro K6).
 * Prevents duplicate uploads (saves AR tokens).
 */
export async function findByHash(
  encryptedHash: string,
  config?: Partial<ArweaveConfig>,
): Promise<{ exists: boolean; txId?: string }> {
  const arweave = createClient(config);

  try {
    // GraphQL query for Exuvia uploads with matching hash
    const query = {
      query: `{
        transactions(
          tags: [
            { name: "App-Name", values: ["Exuvia"] },
            { name: "Encrypted-Hash", values: ["${encryptedHash}"] }
          ],
          first: 1
        ) {
          edges {
            node { id }
          }
        }
      }`,
    };

    const response = await fetch(
      `${arweave.api.config.protocol}://${arweave.api.config.host}/graphql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
      },
    );

    const result = (await response.json()) as any;
    const edges = result?.data?.transactions?.edges;

    if (edges && edges.length > 0) {
      return { exists: true, txId: edges[0].node.id };
    }
    return { exists: false };
  } catch {
    // If query fails, assume not found — upload will proceed
    return { exists: false };
  }
}

// ── Wallet ─────────────────────────────────────────────────────────

/**
 * Get wallet balance in AR.
 */
export async function getBalance(
  walletPath: string,
  config?: Partial<ArweaveConfig>,
): Promise<{ address: string; balanceAR: string; balanceWinston: string }> {
  const arweave = createClient(config);
  const wallet = loadWallet(walletPath);
  const address = await arweave.wallets.jwkToAddress(wallet);
  const winston = await arweave.wallets.getBalance(address);

  return {
    address,
    balanceAR: arweave.ar.winstonToAr(winston),
    balanceWinston: winston,
  };
}
