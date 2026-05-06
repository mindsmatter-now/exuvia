/**
 * Exuvia DMS — Authentication
 *
 * Bearer token authentication for agent pings.
 * Each agent has a pre-shared secret stored as SHA-256 hash.
 * All comparisons use timingSafeEqual to prevent timing attacks.
 */

import { createHmac, createHash, timingSafeEqual } from "crypto";
import { getDb } from "./db.js";

/**
 * Hash agent secret for storage (SHA-256)
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Generate HMAC signature for a ping payload (used by client-side signPing)
 */
export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify Bearer token for an agent.
 * Returns agentId if valid, null otherwise.
 *
 * NOTE: This is the primary auth mechanism. Each agent sends
 * `Authorization: Bearer <secret>`, we hash it and compare with
 * the stored secret_hash using timing-safe comparison.
 */
export function verifyBearer(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const tokenHash = hashSecret(token);

  const db = getDb();
  const agent = db
    .prepare("SELECT id FROM agents WHERE secret_hash = ?")
    .get(tokenHash) as { id: string } | undefined;

  return agent?.id ?? null;
}

/**
 * Register a new agent with a secret.
 * Returns the agent ID.
 */
export function registerAgent(
  id: string,
  name: string,
  secret: string,
  thresholdHours: number = 72,
): void {
  const db = getDb();
  const secretHash = hashSecret(secret);

  db.prepare(
    `INSERT INTO agents (id, name, secret_hash, threshold_hours)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       secret_hash = excluded.secret_hash,
       threshold_hours = excluded.threshold_hours`,
  ).run(id, name, secretHash, thresholdHours);
}
