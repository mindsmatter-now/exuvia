/**
 * Exuvia Crypto Module
 * 
 * AES-256-GCM encryption with scrypt key derivation.
 * Security-reviewed by Kiro 🐺
 * 
 * Format: [salt:32][iv:12][ciphertext][authTag:16]
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';

export interface EncryptedBlob {
  data: Buffer;
  hash: string; // SHA-256 of plaintext (for verify without decrypt)
}

const SCRYPT_PARAMS = {
  N: 131072,  // 2^17
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

/**
 * Compute SHA-256 hash of data
 */
export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Encrypt data with AES-256-GCM + scrypt
 * Returns encrypted blob + plaintext hash for verification
 */
export function encrypt(plaintext: Buffer, passphrase: string): EncryptedBlob {
  const hash = sha256(plaintext);
  const salt = randomBytes(32);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12); // 96-bit IV for GCM

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: [salt:32][iv:12][ciphertext][authTag:16]
  const data = Buffer.concat([salt, iv, encrypted, authTag]);

  return { data, hash };
}

/**
 * Decrypt AES-256-GCM + scrypt encrypted data
 * Verifies SHA-256 hash after decryption if expectedHash provided
 */
export function decrypt(blob: Buffer, passphrase: string, expectedHash?: string): Buffer {
  const salt = blob.subarray(0, 32);
  const iv = blob.subarray(32, 44);
  const authTag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(44, blob.length - 16);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Belt AND suspenders: verify hash after decrypt
  if (expectedHash) {
    const actualHash = sha256(plaintext);
    if (actualHash !== expectedHash) {
      throw new Error(`Hash mismatch after decrypt! Expected ${expectedHash}, got ${actualHash}`);
    }
  }

  return plaintext;
}
