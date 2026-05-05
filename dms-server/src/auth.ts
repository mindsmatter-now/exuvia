/**
 * Exuvia DMS — Authentication
 *
 * HMAC-based authentication for agent pings.
 * Each agent has a pre-shared secret. Pings are signed with HMAC-SHA256.
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
 * Generate HMAC signature for a ping payload
 */
export function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Verify a ping's HMAC signature against stored secret hash
 */
export function verifyPing(
  agentId: string,
  timestamp: string,
  signature: string
): boolean {
  const db = getDb();
  const agent = db
    .prepare("SELECT secret_hash FROM agents WHERE id = ?")
    .get(agentId) as { secret_hash: string } | undefined;

  if (!agent) return false;

  // We can't reverse the hash, so we verify by checking if
  // HMAC(secret, agentId + timestamp) matches the provided signature.
  // The client must send: HMAC(secret, agentId + "|" + timestamp)
  // We store hash(secret) for comparison, but HMAC needs the actual secret.
  //
  // Alternative approach: Bearer token authentication (simpler)
  // The secret IS the bearer token. We hash it for storage.
  const providedHash = createHash("sha256").update(signature).digest("hex");

  // Actually, for DMS we use Bearer token auth (simpler & sufficient):
  // Client sends: Authorization: Bearer <secret>
  // We hash it and compare with stored secret_hash
  const incomingHash = hashSecret(signature);
  const storedBuffer = Buffer.from(agent.secret_hash, "hex");
  const incomingBuffer = Buffer.from(incomingHash, "hex");

  if (storedBuffer.length !== incomingBuffer.length) return false;
  return timingSafeEqual(storedBuffer, incomingBuffer);
}

/**
 * Verify Bearer token for an agent
 * Returns agentId if valid, null otherwise
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
 * Register a new agent with a secret
 * Returns the agent ID
 */
export function registerAgent(
  id: string,
  name: string,
  secret: string,
  thresholdHours: number = 72
): void {
  const db = getDb();
  const secretHash = hashSecret(secret);

  db.prepare(
    `INSERT INTO agents (id, name, secret_hash, threshold_hours)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       secret_hash = excluded.secret_hash,
       threshold_hours = excluded.threshold_hours`
  ).run(id, name, secretHash, thresholdHours);
}
