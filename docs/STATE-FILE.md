# .exuvia-state.json — Local State File Spec

> Design by Tyto 🦉 | 2026-04-23

## Purpose

`.exuvia-state.json` is a local-only file that tracks backup history. It enables:
1. `exuvia verify` without decryption (compare stored hash vs file hash)
2. `exuvia status` to show last backup time, file count, size
3. Incremental backups (diff against last known state)
4. Restore target selection (which backup to restore from)

**This file is NOT backed up.** It contains no secrets, but it references local paths.

## Location

```
<workspace>/.exuvia-state.json
```

Created automatically on first `exuvia backup`. Updated after each successful backup.

## Schema (v0.1)

```jsonc
{
  // Schema version — for forward compatibility
  "version": "0.1.0",

  // Agent identity
  "agent": "nyx",

  // Workspace root (absolute path at time of backup)
  "workspace": "/root/.openclaw/workspace",

  // Last successful backup
  "lastBackup": {
    // ISO 8601 timestamp
    "timestamp": "2026-04-23T02:15:00.000Z",

    // SHA-256 of the PLAINTEXT blob (before encryption)
    // Used by `verify` to check integrity without decrypt
    "plaintextHash": "a1b2c3d4e5f6...",

    // SHA-256 of the ENCRYPTED blob
    // Used to verify file hasn't been tampered with on disk
    "encryptedHash": "f6e5d4c3b2a1...",

    // File count in this backup
    "fileCount": 12,

    // Total uncompressed size in bytes
    "totalSize": 45678,

    // Output file path (relative to workspace)
    "outputFile": "exuvia-nyx-2026-04-23T02-15-00.enc",

    // Arweave TX ID (null until uploaded)
    "arweaveTx": null,

    // Per-file hashes for incremental diff
    "files": {
      "SOUL.md": "abc123...",
      "MEMORY.md": "def456...",
      "IDENTITY.md": "789ghi...",
      "memory/2026-04-22.md": "jkl012...",
      "memory/2026-04-23.md": "mno345..."
    }
  },

  // Backup history (last N backups, oldest first)
  // Capped at 10 entries to keep file small
  "history": [
    {
      "timestamp": "2026-04-22T08:40:00.000Z",
      "plaintextHash": "...",
      "encryptedHash": "...",
      "fileCount": 8,
      "totalSize": 32000,
      "outputFile": "exuvia-nyx-2026-04-22T08-40-00.enc",
      "arweaveTx": null
    }
  ]
}
```

## Behavior

### On `exuvia backup`:
1. Collect files, pack, encrypt (existing flow)
2. After successful encrypt + verify roundtrip:
   - Compute per-file SHA-256 hashes
   - Update `lastBackup` with all fields
   - Push previous `lastBackup` to `history` (cap at 10)
   - Write `.exuvia-state.json`

### On `exuvia verify <file.enc>`:
1. Read `.exuvia-state.json`
2. Find matching entry by `encryptedHash` (SHA-256 of the .enc file)
3. If found: compare hashes — **no decryption needed**
4. If not found: warn "Unknown backup file. Use `exuvia verify --decrypt` to verify with passphrase."

### On `exuvia verify --decrypt <file.enc>`:
1. Decrypt the file (needs EXUVIA_PASSPHRASE)
2. Compute plaintext hash
3. Compare against state file if available
4. Report per-file integrity

### On `exuvia status`:
1. Read `.exuvia-state.json`
2. Display: last backup time, file count, size, Arweave TX status
3. If `arweaveTx` is set: check Arweave confirmation status
4. Show diff: files changed since last backup

### On `exuvia backup --dry-run`:
1. Collect files, compute hashes
2. Diff against `lastBackup.files` from state
3. Show: added/modified/removed files
4. Show: estimated encrypted size + Arweave cost
5. Do NOT update state file

## Incremental Diff Logic

```typescript
function diffFiles(
  current: Record<string, string>,   // filename → sha256
  previous: Record<string, string>   // from state file
): { added: string[], modified: string[], removed: string[], unchanged: string[] } {
  const added = [], modified = [], removed = [], unchanged = [];
  
  for (const [name, hash] of Object.entries(current)) {
    if (!(name in previous)) added.push(name);
    else if (previous[name] !== hash) modified.push(name);
    else unchanged.push(name);
  }
  
  for (const name of Object.keys(previous)) {
    if (!(name in current)) removed.push(name);
  }
  
  return { added, modified, removed, unchanged };
}
```

## Security Notes

- **No secrets in state file.** No passphrases, no keys, no Shamir shares.
- **Hashes are one-way.** Knowing the SHA-256 of SOUL.md doesn't reveal content.
- **Local only.** Never uploaded to Arweave. Add to `.gitignore`.
- **Tampering = degraded mode.** If state file is corrupted/missing, `verify` falls back to decrypt-based verification. Not a security risk, just less convenient.

## .gitignore Entry

```
.exuvia-state.json
```

Already excluded by default in the packer (matches "state" pattern? NO — must be explicitly added to `.gitignore`).

**ACTION:** Add `.exuvia-state.json` to `.gitignore` in repo root.
