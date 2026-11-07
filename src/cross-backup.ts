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

import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "fs";
import { dirname } from "path";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
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
  /** Round id the sender passed with this share (received shares only, optional). */
  roundId?: string;
  /**
   * The share this one replaced, kept only when the receive asked for it
   * (`keepPrevious`, default off, Rudel 26.10.2026). Exactly one level: the
   * previous of a previous is dropped. Still encrypted with the local passphrase.
   */
  previous?: PreviousShare;
}

export interface PreviousShare {
  shareHex: string; // encrypted, exactly as it was stored
  version: number;
  shareHash: string;
  lastVerified?: string;
  roundId?: string;
  replacedAt: string; // ISO timestamp of the receive that replaced it
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
  /**
   * Round id (Rudel, 26.10.2026, Kiro's proposal): random, made fresh by every
   * init (also --force), kept unchanged by rotate. Senders pass it along with a
   * share so a receiver can tell "same round, newer share" from "new round".
   * Not derived from the secret. Optional: states from before round ids lack it.
   */
  roundId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InitResult {
  state: CrossBackupState;
  /** Shares to distribute — map of partnerId → {hex, hash} */
  sharesToSend: Map<string, { hex: string; hash: string }>;
}

// ── Constants ──────────────────────────────────────────────────────

/** File name of the cross-backup state inside stateDir (exported so the CLI never repeats it as text, Kiro). */
export const STATE_FILE = ".exuvia-cross-backup.json";
const CROSS_BACKUP_CIPHER = "aes-256-gcm";

// scrypt params — matches crypto.ts (Tyto: scrypt from day 1, not SHA-256)
export const SCRYPT_PARAMS_PROD = {
  N: 131072, // 2^17
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
};
const SCRYPT_PARAMS_TEST = { N: 1024, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
/** Which scrypt params a given environment selects. Only EXUVIA_TEST_MODE=1 lowers them. */
export function scryptParamsFor(
  env: NodeJS.ProcessEnv,
): typeof SCRYPT_PARAMS_PROD {
  return env.EXUVIA_TEST_MODE === "1" ? SCRYPT_PARAMS_TEST : SCRYPT_PARAMS_PROD;
}
const SCRYPT_PARAMS = scryptParamsFor(process.env);

function deriveShareKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

// ── Share Encryption (Kiro F1: local encryption with own passphrase) ───

/**
 * Encrypt a share hex string with a local passphrase.
 * Uses AES-256-GCM with scrypt-derived key (N=2^17, r=8, p=1).
 * Format: salt(32) + iv(12) + ciphertext + authTag(16) → hex
 */
/**
 * Length of the encrypted state field for a plain share of `shareLength` hex
 * chars. encryptShare encrypts the hex TEXT (one byte per char) and adds
 * salt (32) + iv (12) + GCM tag (16) bytes; all of it is hex again:
 * 2 * (shareLength + 60). Kiro, 05.11.2026: a 66-char share -> 252.
 */
export function blobLengthFor(shareLength: number): number {
  return 2 * (shareLength + 60);
}

export function encryptShare(shareHex: string, passphrase: string): string {
  const salt = randomBytes(32);
  const key = deriveShareKey(passphrase, salt);
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

  const key = deriveShareKey(passphrase, salt);
  const decipher = createDecipheriv(CROSS_BACKUP_CIPHER, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ── Round Id (Rudel 26.10.2026) ─────────────────────────────────────

/** A fresh round id: 16 random bytes as hex. Independent of every secret. */
export function newRoundId(): string {
  return randomBytes(16).toString("hex");
}

/** A round id as it may arrive from outside: 32 lowercase hex chars. */
export function isRoundId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

// ── Share Hash (Kiro F1: integrity verification) ───────────────────

/**
 * SHA-256 hash of a plaintext share for transport verification.
 */
export function hashShare(shareHex: string): string {
  return createHash("sha256").update(shareHex).digest("hex");
}

// ── State Management ───────────────────────────────────────────────

/**
 * Fields every CrossBackupState must have. A file that lacks them was not
 * written by init()/rotate() (e.g. a hand-written holder ledger) and must be
 * rejected loudly — otherwise status() crashes deep inside with a TypeError,
 * or worse, a partial object is treated as a valid backup.
 */
const REQUIRED_STATE_FIELDS: Array<[keyof CrossBackupState, string]> = [
  ["agentId", "string"],
  ["partners", "array"],
  ["localShareHex", "string"],
  ["localShareHash", "string"],
  // Kiro 🐺 (07/08 Oct): without it, status/recovery cannot tell which share is ours.
  ["localShareIndex", "number"],
  ["version", "number"],
  ["threshold", "number"],
  ["total", "number"],
];

const REQUIRED_PARTNER_FIELDS: Array<[keyof Partner, string]> = [
  ["id", "string"],
  ["shareIndex", "number"],
  ["shareHex", "string"],
  ["shareHash", "string"],
];

function partnerProblems(p: unknown, i: number): string[] {
  if (typeof p !== "object" || p === null)
    return [`partners[${i}] (expected object)`];
  const rec = p as Record<string, unknown>;
  return REQUIRED_PARTNER_FIELDS.filter(
    ([f, kind]) => typeof rec[f] !== kind,
  ).map(([f, kind]) => `partners[${i}].${String(f)} (expected ${kind})`);
}

export function loadState(stateDir: string = "."): CrossBackupState | null {
  const path = `${stateDir}/${STATE_FILE}`;
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const problems: string[] = [];
  for (const [field, kind] of REQUIRED_STATE_FIELDS) {
    const v = raw?.[field];
    const ok = kind === "array" ? Array.isArray(v) : typeof v === kind;
    if (!ok) problems.push(`${String(field)} (expected ${kind})`);
  }
  // Kiro 🐺 (06 Oct): an array of WRONG things proves nothing — check every entry.
  if (Array.isArray(raw?.partners)) {
    raw.partners.forEach((p: unknown, i: number) => {
      problems.push(...partnerProblems(p, i));
    });
  }
  // Round id is optional (old states), but if it is there it must be one.
  if (raw?.roundId !== undefined && !isRoundId(raw.roundId)) {
    problems.push("roundId (expected 32 lowercase hex chars or absent)");
  }
  // Kiro 🐺 (10 Oct): the right TYPE is not the right SHARE. 0, -1, 1.5, a
  // number above total or a partner's index all answer "which share is ours?"
  // wrongly, just quietly. Only checked once the types above are fine.
  if (problems.length === 0) {
    const lsi = raw.localShareIndex as number;
    const total = raw.total as number;
    if (
      !Number.isInteger(lsi) ||
      lsi < 1 ||
      !Number.isInteger(total) ||
      lsi > total
    ) {
      problems.push(
        `localShareIndex (expected an integer from 1 to total=${total}, got ${lsi})`,
      );
    } else {
      const clash = (raw.partners as Partner[]).find(
        (p) => p.shareIndex === lsi,
      );
      if (clash) {
        problems.push(
          `localShareIndex (${lsi} is also partner "${clash.id}"'s shareIndex)`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${path} is not a valid cross-backup state: missing/invalid ${problems.join(", ")}. ` +
        `It was probably not written by \`cross-backup init\`. ` +
        `See docs/LOCAL-SHARE-REINIT.md.`,
    );
  }
  return raw as CrossBackupState;
}

/**
 * Low-level write used by saveState, same contract as fs.writeSync(fd, buf,
 * off, len): returns how many bytes landed and may write SHORT without
 * throwing (Kiro, review #29: full disk / ulimit -f). Tests pass their own to
 * simulate short writes and crashes mid-write (issue #17).
 */
export interface SaveStateIo {
  write?: (fd: number, buf: Buffer, offset: number, length: number) => number;
}

/**
 * Persist the state atomically (issue #17, Tyto in review #15): temp file
 * 0600 → fsync → rename over the original. A crash or a full disk while
 * writing leaves the previous state byte-identical instead of truncating it
 * after `rotate` has already thrown the old shares away.
 */
export function saveState(
  state: CrossBackupState,
  stateDir: string = ".",
  io: SaveStateIo = {},
): void {
  state.updatedAt = new Date().toISOString();
  const path = `${stateDir}/${STATE_FILE}`;
  writePrivateAtomic(path, JSON.stringify(state, null, 2), io.write);
}

// ── Round-trip check (Kiro 🐺: only a real decrypt proves the passphrase) ──

/**
 * Optional dependencies for rotate (Kiro 🐺, review #15): passed per call, so
 * there is no shared mutable hook that tests could leak into each other and
 * nothing exported that sees fresh shares. Defaults are the real functions.
 */
export interface RotateOptions {
  split?: typeof splitPassphrase;
  encrypt?: typeof encryptShare;
}

/** All k-sized index subsets of 0..n-1 (n is tiny: holders, not data). */
function subsets(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, cur: number[]) => {
    if (cur.length === k) return void out.push([...cur]);
    for (let i = start; i < n; i++) pick(i + 1, [...cur, i]);
  };
  pick(0, []);
  return out;
}

/**
 * The stored (old) shares must reconstruct exactly `passphrase`. Throws before
 * anything is written if they reconstruct something else, or if there are not
 * enough decryptable stored shares to check (then we cannot prove it → refuse).
 */
export async function assertSamePassphrase(
  state: CrossBackupState,
  localPassphrase: string,
  passphrase: string,
): Promise<void> {
  const stored: Uint8Array[] = [];
  const all = [
    { shareHex: state.localShareHex, shareHash: state.localShareHash },
    ...state.partners,
  ];
  for (const p of all) {
    if (stored.length >= state.threshold) break;
    try {
      const hex = decryptShare(p.shareHex, localPassphrase);
      if (hashShare(hex) === p.shareHash) stored.push(hexToShare(hex));
    } catch {
      /* undecryptable entry: not counted */
    }
  }
  if (stored.length < state.threshold) {
    throw new Error(
      `Rotation aborted: only ${stored.length} of ${state.threshold} stored shares decrypt, cannot verify --passphrase. Nothing was changed. ` +
        "Run `exuvia cross-backup status` to see which entries fail. " +
        "If you are sure of the passphrase: re-init with all partners. " +
        `If not: ask two partners to run \`exuvia cross-backup recover --agent ${state.agentId}\` ` +
        "(recover runs at a partner, not on your own machine).",
    );
  }
  let old: string | null = null;
  try {
    old = await combineShares(stored);
  } catch {
    old = null;
  }
  if (old !== passphrase) {
    throw new Error(
      "Rotation aborted: --passphrase is not the identity passphrase the current shares protect. " +
        "Splitting it would leave a backup that recovers the wrong secret. Nothing was changed.",
    );
  }
}

/**
 * Every threshold-sized subset of `shares` must combine to `passphrase`.
 * Throws naming the first failing subset. Used by rotate before it writes.
 */
export async function verifyThresholdSubsets(
  shares: Uint8Array[],
  threshold: number,
  passphrase: string,
): Promise<number> {
  const sets = subsets(shares.length, threshold);
  for (const set of sets) {
    let got: string | null = null;
    try {
      got = await combineShares(set.map((i) => shares[i]));
    } catch {
      got = null;
    }
    if (got !== passphrase) {
      throw new Error(
        `Rotation aborted: shares [${set.join(", ")}] do not reconstruct the passphrase. Nothing was changed.`,
      );
    }
  }
  return sets.length;
}

/**
 * Decrypt the local share and every stored partner share with
 * `localPassphrase` and compare against the stored hashes. Throws with the
 * first failing share. A structural guard cannot catch a wrong passphrase or
 * a share that was stored as plaintext — this can.
 */
export function verifyStateDecrypts(
  state: CrossBackupState,
  localPassphrase: string,
): void {
  const check = (label: string, hex: string, hash: string) => {
    let plain: string;
    try {
      plain = decryptShare(hex, localPassphrase);
    } catch {
      throw new Error(
        `${label}: cannot be decrypted with this local passphrase ` +
          `(wrong passphrase, or stored unencrypted). See docs/LOCAL-SHARE-REINIT.md.`,
      );
    }
    if (hashShare(plain) !== hash) {
      throw new Error(
        `${label}: decrypts, but the hash does not match the stored hash.`,
      );
    }
  };
  check("local share", state.localShareHex, state.localShareHash);
  for (const p of state.partners) {
    check(`share for ${p.id}`, p.shareHex, p.shareHash);
  }
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
 * @param loadLocalPassphrase - Optional: reads the local passphrase back from
 *   wherever it is KEPT (pass, file, ...). If given, the round-trip check uses
 *   what this returns, not the in-memory argument. That is the only way to
 *   catch "the passphrase was never stored" — the May 2026 failure (Kiro 🐺).
 *
 * init() REPLACES an existing state in stateDir without asking. Callers must
 * guard against that themselves (the CLI refuses unless --force, and keeps a
 * .bak-<time> copy first) — Tyto, review #34.
 */
export async function init(
  agentId: string,
  partnerIds: string[],
  passphrase: string,
  localPassphrase: string,
  stateDir: string = ".",
  loadLocalPassphrase?: () => string | undefined,
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
    roundId: newRoundId(),
    createdAt: now,
    updatedAt: now,
  };

  // Check BEFORE replacing anything (Kiro, review #7 follow-up, 18 Oct): a
  // second init over a good state used to write first and fail afterwards,
  // so the old, working file was already gone. Now the passphrase is read
  // back from where it is KEPT and the new state must decrypt with it before
  // saveState runs.
  let kept = localPassphrase;
  if (loadLocalPassphrase) {
    let loaded: string | undefined;
    try {
      loaded = loadLocalPassphrase();
    } catch (e) {
      loaded = undefined;
    }
    if (!loaded || !loaded.trim()) {
      throw new Error(
        "init: the local passphrase could not be read back from where it is kept " +
          "(not stored?). Store it first, then init. See docs/LOCAL-SHARE-REINIT.md. " +
          "Nothing was written.",
      );
    }
    kept = loaded.trim();
  }
  verifyStateDecrypts(state, kept);

  saveState(state, stateDir);
  // Round-trip through the disk as well: what landed must still decrypt.
  const onDisk = loadState(stateDir);
  if (!onDisk) throw new Error("init: state file vanished right after writing");
  verifyStateDecrypts(onDisk, kept);

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
 * @param roundId - Sender's round id (optional, 32 lowercase hex). Stored with
 *   the share so a later receive can tell "same round" from "new round".
 */
export function receiveShare(
  fromId: string,
  shareHex: string,
  expectedHash: string,
  localPassphrase: string,
  arweaveTxId?: string,
  stateDir: string = ".",
  roundId?: string,
  opts: { keepPrevious?: boolean } = {},
): {
  verified: boolean;
  stored: boolean;
  /** What this call overwrote, if anything (Rudel 26.10.: replace must be loud). */
  replaced?: {
    version: number;
    shareHash: string;
    lastVerified?: string;
    roundId?: string;
  };
  version?: number;
  roundId?: string;
  /** True when the replaced share was kept as `previous` (opt-in only). */
  keptPrevious?: boolean;
} {
  // A malformed round id is refused before anything is read or written.
  if (roundId !== undefined && !isRoundId(roundId)) {
    throw new Error("roundId must be 32 lowercase hex chars");
  }
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
  const prev = received[fromId];
  // Rudel 31.10.2026 (Kiro, design 26./28.10.): a previous is only kept within
  // the SAME round. rotate keeps the round id, init --force sets a new one, so
  // a different or missing id means the old secret is meant to be gone. Refuse
  // loudly instead of keeping it, and do it here so no caller can skip it.
  // Checked before anything is written.
  if (opts.keepPrevious === true && prev !== undefined) {
    if (roundId === undefined || prev.roundId === undefined) {
      throw new Error(
        "keepPrevious needs a round id on both shares (same round only); refusing, nothing written",
      );
    }
    if (prev.roundId !== roundId) {
      throw new Error(
        "keepPrevious only within the same round (rotate keeps the id, init --force sets a new one); refusing, nothing written",
      );
    }
  }
  received[fromId] = {
    id: fromId,
    shareIndex: 0, // unknown, we just store what we got
    shareHex: encryptShare(shareHex, localPassphrase),
    version: (received[fromId]?.version ?? 0) + 1,
    shareHash: actualHash,
    createdAt: received[fromId]?.createdAt ?? now,
    lastVerified: now,
    arweaveTxId,
    ...(roundId !== undefined ? { roundId } : {}),
  };
  // Keep the replaced share only on request, same round only (checked above),
  // and only one level deep. Without
  // the flag any older `previous` goes too: a replace without keep means the
  // old secret is meant to be gone (compromised passphrase, Rudel 26.10.).
  const keptPrevious = opts.keepPrevious === true && prev !== undefined;
  if (keptPrevious) {
    received[fromId].previous = {
      shareHex: prev.shareHex,
      version: prev.version,
      shareHash: prev.shareHash,
      lastVerified: prev.lastVerified,
      ...(prev.roundId !== undefined ? { roundId: prev.roundId } : {}),
      replacedAt: now,
    };
  }

  writePrivateAtomic(receivedPath, JSON.stringify(received, null, 2));
  return {
    verified: true,
    stored: true,
    version: received[fromId].version,
    roundId,
    keptPrevious,
    replaced: prev
      ? {
          version: prev.version,
          shareHash: prev.shareHash,
          lastVerified: prev.lastVerified,
          roundId: prev.roundId,
        }
      : undefined,
  };
}

/**
 * Drop the kept previous share of one partner (previous step 5, Rudel
 * 03.11.2026). The counterpart to receive --keep-previous: once the new
 * round is confirmed, the old secret should be gone on purpose, not only by
 * the next receive. Needs no passphrase (nothing is decrypted). Refuses an
 * unknown partner. No previous kept → dropped: false and nothing is written,
 * so a typo never looks like a cleanup.
 */
export function dropPrevious(
  fromId: string,
  stateDir: string = ".",
): { dropped: boolean; version?: number; shareHash?: string } {
  const receivedPath = `${stateDir}/.exuvia-received-shares.json`;
  if (!existsSync(receivedPath)) {
    throw new Error(`No received shares in ${stateDir}; nothing to drop.`);
  }
  const received: Record<string, Partner> = JSON.parse(
    readFileSync(receivedPath, "utf8"),
  );
  const entry = received[fromId];
  if (!entry) {
    throw new Error(`No share received from "${fromId}"; nothing to drop.`);
  }
  if (!entry.previous) return { dropped: false };
  const { version, shareHash } = entry.previous;
  delete entry.previous;
  writePrivateAtomic(receivedPath, JSON.stringify(received, null, 2));
  return { dropped: true, version, shareHash };
}

/**
 * Write `content` to `path` as 0600, atomically (Tyto, review #20): a fresh
 * temp file is created 0600, fsynced, then renamed over the target. The new
 * content is never in a 0644 file, and a crash mid-write leaves the old file
 * intact instead of truncating every received share.
 */
export function writePrivateAtomic(
  path: string,
  content: string,
  write: (
    fd: number,
    buf: Buffer,
    offset: number,
    length: number,
  ) => number = writeSync,
): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      // writeSync may write short and return the count WITHOUT throwing
      // (Kiro, review #29). Loop until every byte is down; the next call then
      // raises the real ENOSPC/EFBIG instead of renaming a truncated file.
      const buf = Buffer.from(content, "utf8");
      let off = 0;
      while (off < buf.length) {
        const n = write(fd, buf, off, buf.length - off);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`short write: ${off}/${buf.length} bytes, then ${n}`);
        }
        off += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600); // umask cannot widen it, but be explicit
    renameSync(tmp, path);
  } catch (e) {
    // disk full etc.: never leave a temp copy of all received shares behind (Tyto)
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
  // make the rename itself durable (Tyto; mostly a no-op on ext4)
  try {
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* some platforms cannot fsync a directory */
  }
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
  /** Our round id, or undefined for a state from before round ids. */
  roundId?: string;
  threshold: number;
  total: number;
  localShareOk: boolean;
  /**
   * Result of the same full check init runs (verifyStateDecrypts): the local
   * share AND every stored partner share decrypt with this passphrase and
   * match their hashes. `null` = all ok, otherwise the first failure label.
   * (Tyto, 09 Oct: Step 5 promised "all partners", status only checked local.)
   */
  allSharesError: string | null;
  partners: Array<{
    id: string;
    hasShare: boolean;
    shareOk: boolean;
    version: number;
    lastVerified?: string;
    arweaveTxId?: string;
  }>;
  receivedShares: Array<{
    fromId: string;
    shareOk: boolean;
    version: number;
    shareHash: string;
    lastVerified?: string;
    arweaveTxId?: string;
    /** Round id the sender passed with the share, if any. */
    roundId?: string;
    /** A kept previous share, if any (metadata only, never the share). */
    previous?: {
      version: number;
      shareHash: string;
      roundId?: string;
      replacedAt: string;
      /** Kept previous decrypts with our passphrase and matches its hash. */
      previousOk: boolean;
    };
  }>;
}

// ── Rotate ──────────────────────────────────────────────────────────

export interface RotateResult {
  newVersion: number;
  /** Round id after rotate (kept from before; undefined for an old state). */
  roundId?: string;
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
 * @param opts - Optional split/encrypt replacements (tests inject faults here)
 */
export async function rotate(
  passphrase: string,
  localPassphrase: string,
  stateDir: string = ".",
  opts: RotateOptions = {},
): Promise<RotateResult> {
  const split = opts.split ?? splitPassphrase;
  const encrypt = opts.encrypt ?? encryptShare;
  const state = loadState(stateDir);
  if (!state) {
    throw new Error("No cross-backup state found. Run init first.");
  }

  // Tyto, 12 Oct: the local passphrase must be the STORED one. Without this
  // check a typo or the wrong tmpfs file re-encrypts the whole state under a
  // passphrase nobody knows — exit 0, version +1, "Rotation complete".
  // Same rule as init (which reads back what it wrote): prove before writing.
  let storedOk = false;
  try {
    storedOk =
      hashShare(decryptShare(state.localShareHex, localPassphrase)) ===
      state.localShareHash;
  } catch {
    storedOk = false;
  }
  if (!storedOk) {
    throw new Error(
      "Local passphrase does not match the stored state (cannot decrypt the local share). Nothing was changed.",
    );
  }

  const partnerIds = state.partners.map((p) => p.id);
  const allHolders = [state.agentId, ...partnerIds];
  const threshold = state.threshold;

  // Tyto, 12 Oct ("probably the most dangerous spot in the tool"): rotate never
  // checked that --passphrase is the REAL identity passphrase. A typo split a
  // wrong secret cleanly — three valid shares, unrecoverable backup. The old
  // shares are all still in the state (encrypted with the local passphrase we
  // just proved), so combine `threshold` of them and compare. No blob, no
  // stored hash needed.
  await assertSamePassphrase(state, localPassphrase, passphrase);

  // Re-split passphrase with same structure
  const shamir = await split(passphrase, allHolders, threshold);

  // Tyto, 12 Oct: prove the new shares BEFORE anything is written. Every
  // threshold-sized subset must reconstruct exactly this passphrase. A broken
  // share would otherwise only show up on recovery day — when it is too late.
  await verifyThresholdSubsets(shamir.shares, threshold, passphrase);

  // Update local share
  const localShareHex = shareToHex(shamir.shares[0]);
  const localShareHash = hashShare(localShareHex);
  state.localShareHex = encrypt(localShareHex, localPassphrase);
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
      shareHex: encrypt(partnerShareHex, localPassphrase),
      shareHash: partnerShareHash,
      version: state.version,
      lastVerified: undefined, // needs re-verification after rotation
    };

    sharesToSend.set(partnerIds[i], {
      hex: partnerShareHex,
      hash: partnerShareHash,
    });
  }

  // Same check init runs after writing, here before: every stored share must
  // decrypt with the local passphrase and match its hash.
  verifyStateDecrypts(state, localPassphrase);

  saveState(state, stateDir);

  return { newVersion: state.version, roundId: state.roundId, sharesToSend };
}

// ── Recover ────────────────────────────────────────────────────────

export interface RecoverResult {
  agentId: string;
  passphrase: string;
  sharesUsed: number;
}

/**
 * What a helper hands over with its plain share (Rudel 05.11.2026): the hash
 * of exactly that hex, and the round id of the share it came from ("none" for
 * shares received before round ids existed, i.e. before 26.10.2026).
 * The version is deliberately NOT part of it: a received share's version is
 * a local receive counter, not the sender's rotation (Tyto, cross-backup.ts
 * receiveShare), so comparing it would look green without proving anything.
 */
export interface HelperShareCheck {
  hash: string;
  round: string;
}

export interface OwnShare {
  shareHex: string;
  shareHash: string;
  /** Round id of the stored share, undefined for shares from before 26.10. */
  roundId?: string;
  version: number;
}

/** "none" or a round id, as show-share prints it and recover expects it. */
export function roundLabel(roundId: string | undefined): string {
  return roundId ?? "none";
}

/**
 * Decrypt and verify the share WE hold for `agentId` (current, or the kept
 * previous with usePrevious). Shared by recover (coordinator) and showShare
 * (helper) so both sides apply exactly the same rule. Never falls back from
 * previous to current.
 */
function loadOwnShare(
  agentId: string,
  localPassphrase: string,
  stateDir: string,
  usePrevious: boolean,
): OwnShare {
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

  // usePrevious (Rudel 02.11.2026): the kept previous share instead of the
  // current one. It is never a silent fallback: if no previous was kept, or
  // it fails the same decrypt + hash rule as previousOk, we refuse — mixing
  // rounds recovers garbage.
  let source: {
    shareHex: string;
    shareHash: string;
    roundId?: string;
    version: number;
  } = partnerData;
  let label = "stored share";
  if (usePrevious) {
    if (!partnerData.previous) {
      throw new Error(
        `No previous share kept for agent "${agentId}". ` +
          "Receive with --keep-previous to keep one. Cannot recover from previous.",
      );
    }
    source = partnerData.previous;
    label = "previous share";
  }

  let shareHex: string;
  try {
    shareHex = decryptShare(source.shareHex, localPassphrase);
  } catch {
    throw new Error(`Failed to decrypt ${label}. Wrong passphrase?`);
  }

  if (hashShare(shareHex) !== source.shareHash) {
    throw new Error(
      usePrevious
        ? "Previous share integrity check failed (previousOk = false). Refusing to recover from it."
        : "Stored share integrity check failed.",
    );
  }

  return {
    shareHex,
    shareHash: source.shareHash,
    roundId: source.roundId,
    version: source.version,
  };
}

/**
 * Helper half of recover (Rudel 05.11.2026): decrypt the share we hold for a
 * downed agent and hand it out, together with its hash and round, so the
 * coordinator can check both. Same decrypt + hash rule as recover, same
 * usePrevious semantics, no fallback.
 *
 * Refuses our own id: we never hold a share of ourselves, and asking for it
 * means the wrong id was typed.
 *
 * The caller must never send the hex in the clear (see EXCHANGE-RUNBOOK,
 * "Recovery"): encrypt it with a fresh transfer passphrase first.
 */
export function showShare(
  agentId: string,
  localPassphrase: string,
  stateDir: string = ".",
  opts: { usePrevious?: boolean } = {},
): OwnShare {
  let ownId: string | undefined;
  try {
    ownId = loadState(stateDir)?.agentId;
  } catch {
    ownId = undefined; // no / unreadable own state: nothing to compare with
  }
  if (ownId !== undefined && ownId === agentId) {
    throw new Error(
      `"${agentId}" is your own id. show-share takes the id of the agent whose share you hold (the one that is down), not yours.`,
    );
  }
  return loadOwnShare(agentId, localPassphrase, stateDir, !!opts.usePrevious);
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
 * @param opts.usePrevious - Use the kept previous share instead of the current
 *   one. Refuses (never falls back) if none was kept or it fails decrypt/hash.
 * @param opts.helpers - One check per additional share, same order (Rudel
 *   05.11.2026): the share must match its hash, and its round must equal the
 *   round of OUR source share ("none" only against a source without round, in
 *   both directions). Any mismatch, missing entry or count mismatch refuses
 *   before combining. The CLI always passes it; library callers that omit it
 *   get the old unchecked behaviour.
 *   ⚠️ This does NOT tell N from N+1 within one round (same round id, and
 *   the stored version is a local counter). That stays a runbook step.
 */
export async function recover(
  agentId: string,
  localPassphrase: string,
  additionalShares: string[],
  stateDir: string = ".",
  opts: { usePrevious?: boolean; helpers?: HelperShareCheck[] } = {},
): Promise<RecoverResult> {
  const own = loadOwnShare(
    agentId,
    localPassphrase,
    stateDir,
    !!opts.usePrevious,
  );

  if (opts.helpers !== undefined) {
    checkHelperShares(
      additionalShares,
      opts.helpers,
      own.roundId,
      own.shareHex.length,
    );
  }

  // Combine all shares
  const allShareHexes = [own.shareHex, ...additionalShares];
  const shares = allShareHexes.map(hexToShare);

  const passphrase = await combineShares(shares);

  return {
    agentId,
    passphrase,
    sharesUsed: allShareHexes.length,
  };
}

/**
 * Check every helper share against its hash and round before anything is
 * combined. Throws on the first problem; the message never contains a share.
 */
export function checkHelperShares(
  shares: string[],
  helpers: HelperShareCheck[],
  ownRoundId: string | undefined,
  ownLength?: number,
): void {
  if (shares.length !== helpers.length) {
    throw new Error(
      `${shares.length} helper share(s) but ${helpers.length} hash/round pair(s): every helper share needs exactly one --hash and one --round, in the same order.`,
    );
  }
  const ownLabel = roundLabel(ownRoundId);
  shares.forEach((hex, i) => {
    const n = i + 1;
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(`Helper share ${n} is not lowercase hex.`);
    }
    // Rudel 05./06.11.2026 (Kiro, Nyx): all shares of one secret have the
    // same length. A share of length blobLengthFor(ours) is the encrypted
    // state field and not the plain share; Kiro measured that case on 05.11.
    // (252 vs 66). No fixed
    // length is assumed: we compare with OUR share of the same secret.
    if (ownLength !== undefined && hex.length !== ownLength) {
      throw new Error(
        hex.length === blobLengthFor(ownLength)
          ? `Helper share ${n} has ${hex.length} hex chars, exactly the length of an encrypted copy of our ${ownLength}-char share: that is the ENCRYPTED state field, not the plain share. The helper should use show-share. Nothing combined.`
          : `Helper share ${n} has ${hex.length} hex chars, our share of the same secret has ${ownLength}. Shares of one secret are always the same length. Nothing combined.`,
      );
    }
    const h = helpers[i];
    if (!/^[0-9a-f]{64}$/.test(h.hash)) {
      throw new Error(`Hash ${n} is not a sha256 (64 lowercase hex chars).`);
    }
    if (h.round !== "none" && !isRoundId(h.round)) {
      throw new Error(
        `Round ${n} must be a round id (32 lowercase hex chars) or "none".`,
      );
    }
    if (hashShare(hex) !== h.hash) {
      throw new Error(
        `Helper share ${n} does not match its hash (wrong transfer passphrase, damaged on the way, or the wrong share). Nothing combined.`,
      );
    }
    if (h.round !== ownLabel) {
      throw new Error(
        `Helper share ${n} is from round ${h.round}, our share is from round ${ownLabel}. Both shares must come from the same round. Nothing combined.`,
      );
    }
  });
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

  // Same full check as init: every stored share must decrypt + match its hash.
  let allSharesError: string | null = null;
  try {
    verifyStateDecrypts(state, localPassphrase);
  } catch (e) {
    allSharesError = e instanceof Error ? e.message : String(e);
  }
  const partnerOk = (p: { shareHex: string; shareHash: string }): boolean => {
    try {
      return (
        hashShare(decryptShare(p.shareHex, localPassphrase)) === p.shareHash
      );
    } catch {
      return false;
    }
  };

  // Load received shares
  const receivedPath = `${stateDir}/.exuvia-received-shares.json`;
  let received: Record<string, Partner> = {};
  if (existsSync(receivedPath)) {
    received = JSON.parse(readFileSync(receivedPath, "utf8"));
  }

  return {
    agentId: state.agentId,
    version: state.version,
    roundId: state.roundId,
    threshold: state.threshold,
    total: state.total,
    localShareOk,
    allSharesError,
    partners: state.partners.map((p) => ({
      id: p.id,
      hasShare: true,
      shareOk: partnerOk(p),
      version: p.version,
      lastVerified: p.lastVerified,
      arweaveTxId: p.arweaveTxId,
    })),
    // Shares we HOLD for partners were listed but never checked, so a
    // tampered received file still read "COMPLETE". Same decrypt + hash rule.
    receivedShares: Object.values(received).map((r) => ({
      fromId: r.id,
      shareOk: partnerOk(r),
      version: r.version,
      shareHash: r.shareHash,
      lastVerified: r.lastVerified,
      arweaveTxId: r.arweaveTxId,
      roundId: r.roundId,
      ...(r.previous
        ? {
            previous: {
              version: r.previous.version,
              shareHash: r.previous.shareHash,
              roundId: r.previous.roundId,
              replacedAt: r.previous.replacedAt,
              // Tyto 31.10.2026: shareOk only covered the current share. A
              // previous that no longer decrypts would only show up on the
              // day someone needs it. Same decrypt + hash rule, checked now.
              previousOk: partnerOk(r.previous),
            },
          }
        : {}),
    })),
  };
}
