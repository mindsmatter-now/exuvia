/**
 * Exuvia Shamir Module
 *
 * 2-of-3 Shamir Secret Sharing for passphrase recovery.
 * Library: shamir-secret-sharing (Privy.io, audited, zero-dep, GF(2^8))
 *
 * Approved by Kiro 🐺, architecture by Tyto 🦉
 */

import { split, combine } from 'shamir-secret-sharing';

export interface ShamirShares {
  threshold: number;
  total: number;
  shares: Uint8Array[];
  holders: string[];
}

const DEFAULT_THRESHOLD = 2;
const DEFAULT_TOTAL = 3;
const DEFAULT_HOLDERS = ['kiro', 'tyto', 'alex'];

/**
 * Split a passphrase into Shamir shares (2-of-3)
 */
export async function splitPassphrase(
  passphrase: string,
  holders: string[] = DEFAULT_HOLDERS,
  threshold: number = DEFAULT_THRESHOLD
): Promise<ShamirShares> {
  const secret = new TextEncoder().encode(passphrase);
  const total = holders.length;

  if (total < threshold) {
    throw new Error(`Need at least ${threshold} holders, got ${total}`);
  }
  if (threshold < 2) {
    throw new Error('Threshold must be at least 2');
  }

  const shares = await split(secret, total, threshold);

  return {
    threshold,
    total,
    shares,
    holders,
  };
}

/**
 * Reconstruct passphrase from Shamir shares
 */
export async function combineShares(shares: Uint8Array[]): Promise<string> {
  if (shares.length < 2) {
    throw new Error('Need at least 2 shares to reconstruct');
  }

  const secret = await combine(shares);
  return new TextDecoder().decode(secret);
}

/**
 * Encode a share as hex string (for safe transport/storage)
 */
export function shareToHex(share: Uint8Array): string {
  return Buffer.from(share).toString('hex');
}

/**
 * Decode a hex string back to share
 */
export function hexToShare(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Format shares for distribution (human-readable)
 */
export function formatSharesForDistribution(result: ShamirShares): string {
  const lines: string[] = [
    `🔐 Exuvia Shamir Shares — ${result.threshold}-of-${result.total}`,
    `   Generated: ${new Date().toISOString()}`,
    `   Any ${result.threshold} shares can reconstruct the passphrase.`,
    `   Each share ALONE is useless.\n`,
  ];

  for (let i = 0; i < result.shares.length; i++) {
    lines.push(`📧 Share ${i + 1} → ${result.holders[i]}`);
    lines.push(`   ${shareToHex(result.shares[i])}\n`);
  }

  lines.push('⚠️  NEVER send multiple shares over the same channel!');
  lines.push('⚠️  Each holder stores their share independently.');

  return lines.join('\n');
}
