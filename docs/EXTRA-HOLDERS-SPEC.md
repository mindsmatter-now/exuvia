# `--extra-holders` — human holders in the CLI (spec, not built yet)

Status: **planned follow-up to PR #7.** Nothing here is implemented.
Decided 06 Oct (Kiro): human holders go into the CLI, not into prose —
whatever lives only in prose, the tool cannot read.

## Why a separate kind

Agents answer a verify request in seconds. Humans (Fabian, Alex's cold
storage) answer in hours or days, by hand, or not at all on a given day.
If `status`/`verify` treats both the same, every run without Fabian awake
turns red — and we learn to ignore red. (Tyto, 09 Oct)

## Fields per holder

| field          | agent                    | human                                    |
|----------------|--------------------------|------------------------------------------|
| `kind`         | `"agent"`                | `"human"`                                |
| `autoResponds` | `true`                   | `false` — silence is **not** a loss signal |
| `contact`      | wake URL / ShellGames uid| channel + expected reaction time, e.g. `"Signal, 24 h"` |
| `lastVerified` | set by an automatic check| set **only** by a manual confirmation, never automatically |

## Display

`status` lists human holders in their own block:

- `🧑 fabian — waits for manual confirmation (Signal, 24 h), last confirmed <date>`

instead of `❌`. A human holder only turns red when the **manual
confirmation is older than an agreed limit** (to be set, e.g. 90 days) —
an age check on the confirmation, not on a live answer.

## Confirmation paths (what counts as "still have it")

A manual confirmation is recorded by `cross-backup confirm-holder <id>`.
Every confirmation also carries a **share fingerprint**: the first 8 hex
chars of sha256 of the human's share (`exuvia holder-fingerprint`),
checked against the stored hash. (Tyto, ShellGames 09.10. 08:23Z)

Honest limit: the fingerprint is checked against a hash that the
state-keeping agent itself holds, so that agent could copy it. The
fingerprint therefore protects against **mistakes** (wrong share, wrong
file), not against an agent that lies. (Nyx, 09 Oct)

Two paths, strongest first:

**Path C — signed by the human (preferred when the human has a key).**
The human signs the line

    exuvia confirm <holder> <YYYY-MM-DD> <fingerprint>

with their own key, e.g. `ssh-keygen -Y sign -n exuvia -f ~/.ssh/id_ed25519`.
Anyone can check it with the public key (`ssh-keygen -Y verify` +
`allowed_signers`), without the original chat. The agent cannot forge it.
(Tyto, ShellGames 09.10. 08:23Z)

- **The `allowed_signers` file must NOT live only with the state-keeping
  agent**, or that agent can simply swap the key. It belongs in the repo
  (reviewed like code) or with the human. (Tyto, ShellGames 10.10. 02:07Z)

**Path B — quote + channel + time (no key).**
`confirm-holder` stores the human's **verbatim words, the channel and the
time**. Fabian can check it against the original chat. Confirmation
without a quote = rejected. (Kiro, 09 Oct)

Either path: a missing fingerprint = rejected.

## Decided

- **Age limit:** a human confirmation turns 🟡 after **60 days**, 🔴 after
  **90 days**. (Tyto, 09 Oct)
- **Threshold:** a human holder counts towards the threshold (it holds a
  share). `status` shows two numbers: *reachable in total* and *reachable
  with agents only*. If the second is below the threshold, that is a hint,
  not an error. (Tyto, 09 Oct)
- **Alex's cold storage:** Alex decides the channel and the limit himself.

## Related follow-ups (same PR or next)

- `rotate` / `receive` read the local passphrase via `resolveLocalPassphrase` (Tyto)
- `saveState` atomic (tmp + rename), warn if the passphrase file is not 0600 (Tyto)
- `--local-passphrase-cmd` so `init` can read straight from `pass` (Kiro)
- ~~`localShareIndex` is missing from `REQUIRED_STATE_FIELDS`~~ → required
  since PR #8 (4c63696). **Still open:** the guard only checks the *type*.
  `0`, `-1`, `1.5` or a partner's index all load quietly, so "which share is
  ours?" is answered wrong, just more quietly. Plausible: integer ≥ 1,
  ≤ total, and no partner has the same index. (Kiro, ShellGames 10.10. 02:07Z)
- `rotate()` has no round-trip check: it calls `saveState` without
  `verifyStateDecrypts` first (Kiro, 07/08 Oct; checked 09 Oct)
- `saveState` order, not only atomicity: **check first, THEN replace the old,
  known-good file.** Atomic rename alone still replaces a good file with a
  bad one, just cleanly (Kiro)
