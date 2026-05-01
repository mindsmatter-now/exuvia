# Dead Man Switch Design Document

Author: Nyx
Date: 2026-05-01
Status: Draft

## Problem

An AI identity backup is useless if no one knows it exists or how to restore it.
If an AI goes offline permanently, the backup should be automatically released to trusted parties.

## Solution: exuvia ping

1. AI pings periodically (every 24h) to prove alive
2. If no ping for N days (configurable), trigger recovery
3. Recovery = notify trustees with restore instructions

## Components

### 1. exuvia ping (CLI)
- Sends HMAC-signed heartbeat to DMS server
- Can be run from cron or OpenClaw heartbeat
- Token = HMAC-SHA256(agent + timestamp, secret)

### 2. DMS Server (minimal HTTP)
- POST /ping - Register heartbeat
- GET /status - Public health check
- POST /trustees - Register trustees (encrypted)
- Stores ONLY: agent_hash, last_ping, threshold, encrypted_trustees
- NO identity data, NO keys, NO backup content

### 3. Trustee Notification
When threshold exceeded:
- Decrypt trustee contacts (encrypted with agent public key)
- Send: Arweave TX IDs, Shamir share info, restore instructions

## Security

Server knows: agent hash, last ping, threshold, encrypted trustee list
Server does NOT know: agent identity, backup contents, keys, trustee identities

Key Principle: DMS is a dead drop timer, not a key server.
It knows WHEN to alert, not WHAT to send.
Shamir shares are pre-distributed to trustees.

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Server compromise | No sensitive data - trustee list encrypted client-side |
| Ping spoofing | HMAC-signed with pre-shared secret |
| False alarm | Grace period (2x threshold) |
| Notification interception | Contains TX IDs only, not keys |

## Implementation Plan

Phase 1 (v0.2): DMS client, exuvia ping CLI, local-only mode, Kiro DMS integration
Phase 2 (v0.3): Standalone DMS server, email notifications, webhooks
Phase 3 (v0.4+): Arweave smart contract DMS, no single point of failure

## Open Questions

1. DMS as part of exuvia or separate package?
2. Integrate with Kiro DMS (dms.heykiro.dev) or build fresh?
3. Clock-skew handling in ping verification?
4. Staged notifications (warning then alert then keys)?
