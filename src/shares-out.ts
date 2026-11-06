/**
 * `--shares-out <dir>` for cross-backup init/rotate (Rudel, 05/06 Nov 2026).
 *
 * init/rotate used to print only `share.hex.slice(0, 32)...`, while the
 * runbook (Phase 1) promised the full share + hash and Phase 2 needs
 * `<share-hex>`. Whoever started exchange B would stand in front of the gap
 * of 13 May and reach into the state file again (Tyto). Now each partner's
 * plaintext share goes into its own 0600 file in a directory the operator
 * prepared; the terminal only shows hash + path. Phase 2 reads it with
 * `receive --share-file`, no copy-paste.
 *
 * Rules for the directory (Tyto, review of the plan, 05 Nov — after #42,
 * where a state file landed in the repo):
 *  - must already exist, be a directory, mode exactly 0700, owned by us
 *  - must not lie inside a git worktree, and not inside / equal --state-dir
 *  - files are created with O_EXCL (never overwrite), mode 0600
 *  - warn (do not refuse) if it is not a tmpfs
 *  - partner ids become file names, so each must be a plain name
 *    (Tyto, review #57: `--partners ../x` wrote one level above the
 *    checked directory and bypassed every rule above)
 *  - --state-dir must not lie inside it either (Tyto ⚪, review #57)
 * Everything is checked BEFORE init/rotate touch the state.
 */
import {
  existsSync,
  statSync,
  realpathSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  statfsSync,
} from "fs";
import { join, dirname, sep } from "path";

/** Linux TMPFS_MAGIC (statfs f_type). */
const TMPFS_MAGIC = 0x01021994;

/**
 * A partner id that is safe as a file name: lowercase letters, digits, "_"
 * and "-", starting with a letter or digit. No "/", no "..", no dot files.
 */
const SAFE_PARTNER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertSafePartnerId(partnerId: string): void {
  if (!SAFE_PARTNER_ID.test(partnerId)) {
    throw new Error(
      `partner id ${JSON.stringify(partnerId)} is not a plain name (a-z, 0-9, _ and -, max 64); it becomes a file name in --shares-out`,
    );
  }
}

export function shareFileName(partnerId: string): string {
  assertSafePartnerId(partnerId);
  return `${partnerId}.share`;
}
export function hashFileName(partnerId: string): string {
  assertSafePartnerId(partnerId);
  return `${partnerId}.share.sha256`;
}

/** Nearest ancestor (incl. itself) that holds a `.git` entry, or undefined. */
export function findGitRoot(dir: string): string | undefined {
  let cur = realpathSync(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

function inside(child: string, parent: string): boolean {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  );
}

/**
 * Throws with a reason if `dir` must not receive shares. Returns warnings
 * (e.g. "not a tmpfs") that the caller prints. Pure check: writes nothing.
 */
export function checkSharesOutDir(
  dir: string,
  stateDir: string,
  partnerIds: string[],
  fsType: (d: string) => number = (d) => Number(statfsSync(d).type),
): string[] {
  // Ids first: they decide where files go, so nothing else is meaningful
  // until every one of them is a plain name.
  for (const p of partnerIds) assertSafePartnerId(p);
  if (!existsSync(dir)) {
    throw new Error(
      `--shares-out ${dir} does not exist (create it first: mkdir -m 700)`,
    );
  }
  const st = statSync(dir);
  if (!st.isDirectory())
    throw new Error(`--shares-out ${dir} is not a directory`);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(
      `--shares-out ${dir} has mode ${mode.toString(8).padStart(3, "0")}, needs exactly 700 (chmod 700)`,
    );
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`--shares-out ${dir} is not owned by the current user`);
  }
  const real = realpathSync(dir);
  const git = findGitRoot(real);
  if (git) {
    throw new Error(
      `--shares-out ${dir} lies inside a git worktree (${git}); shares must never land in a repo (#42)`,
    );
  }
  if (existsSync(stateDir)) {
    const realState = realpathSync(stateDir);
    if (inside(real, realState)) {
      throw new Error(
        `--shares-out ${dir} lies inside --state-dir ${stateDir}; keep plaintext shares apart from the state`,
      );
    }
    if (inside(realState, real)) {
      throw new Error(
        `--state-dir ${stateDir} lies inside --shares-out ${dir}; keep plaintext shares apart from the state`,
      );
    }
  }
  const taken = partnerIds
    .flatMap((p) => [shareFileName(p), hashFileName(p)])
    .filter((f) => existsSync(join(real, f)));
  if (taken.length > 0) {
    throw new Error(
      `--shares-out ${dir} already holds ${taken.join(", ")}; never overwritten, remove them first`,
    );
  }
  const warnings: string[] = [];
  let type: number | undefined;
  try {
    type = fsType(real);
  } catch {
    type = undefined;
  }
  if (type !== TMPFS_MAGIC) {
    warnings.push(
      `⚠️  --shares-out ${dir} is not a tmpfs: plaintext shares will touch the disk. Prefer e.g. /dev/shm or /run/user/$UID`,
    );
  }
  return warnings;
}

function writeExcl(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    const buf = Buffer.from(content, "utf8");
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (!Number.isInteger(n) || n <= 0)
        throw new Error(`short write on ${path}`);
      off += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `<partner>.share` (hex + "\n") and `<partner>.share.sha256` (hash +
 * "\n") per partner, O_EXCL, 0600. On any failure, removes what THIS call
 * created and rethrows: no half set of shares left behind.
 */
export function writeSharesOut(
  dir: string,
  shares: Map<string, { hex: string; hash: string }>,
): Array<{
  partnerId: string;
  sharePath: string;
  hashPath: string;
  hash: string;
}> {
  const real = realpathSync(dir);
  const created: string[] = [];
  const out: Array<{
    partnerId: string;
    sharePath: string;
    hashPath: string;
    hash: string;
  }> = [];
  try {
    for (const [partnerId, share] of shares) {
      const sharePath = join(real, shareFileName(partnerId));
      const hashPath = join(real, hashFileName(partnerId));
      writeExcl(sharePath, `${share.hex}\n`);
      created.push(sharePath);
      writeExcl(hashPath, `${share.hash}\n`);
      created.push(hashPath);
      out.push({ partnerId, sharePath, hashPath, hash: share.hash });
    }
  } catch (e) {
    for (const p of created) {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    }
    throw e;
  }
  return out;
}
