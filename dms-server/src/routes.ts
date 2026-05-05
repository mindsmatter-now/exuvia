/**
 * Exuvia DMS — API Routes
 *
 * Endpoints per Tyto's spec:
 * - POST /ping — Agent heartbeat (Bearer auth)
 * - GET /status/:agentId — Public DMS status
 * - GET /attestation/:agentId — Timeout attestation
 * - POST /snooze — Extend timer (with max-limit)
 */

import { Hono } from "hono";
import { getDb } from "./db.js";
import { verifyBearer } from "./auth.js";

const app = new Hono();

app.post("/ping", async (c) => {
  const agentId = verifyBearer(c.req.header("Authorization"));
  if (!agentId) return c.json({ error: "Unauthorized" }, 401);

  const db = getDb();
  const now = new Date().toISOString();
  const ip = c.req.header("x-forwarded-for") || "unknown";
  const body = await c.req.json().catch(() => ({}));

  db.prepare(
    "INSERT INTO pings (agent_id, timestamp, ip, metadata) VALUES (?, ?, ?, ?)"
  ).run(agentId, now, ip, JSON.stringify(body));

  db.prepare(
    "UPDATE agents SET last_ping = ?, ping_count = ping_count + 1, status = 'active' WHERE id = ?"
  ).run(now, agentId);

  db.prepare(
    "INSERT INTO attestations (agent_id, type, timestamp) VALUES (?, 'alive', ?)"
  ).run(agentId, now);

  const agent = db.prepare("SELECT ping_count, threshold_hours FROM agents WHERE id = ?")
    .get(agentId) as { ping_count: number; threshold_hours: number };

  return c.json({ ok: true, pingCount: agent.ping_count, lastBeat: now, thresholdHours: agent.threshold_hours });
});

app.get("/status/:agentId", (c) => {
  const { agentId } = c.req.param();
  const db = getDb();

  const agent = db.prepare(
    "SELECT id, name, last_ping, ping_count, status, threshold_hours, created_at FROM agents WHERE id = ?"
  ).get(agentId) as any;

  if (!agent) return c.json({ error: "Agent not found" }, 404);

  const lastPing = agent.last_ping ? new Date(agent.last_ping) : null;
  const hoursSinceLastPing = lastPing ? (Date.now() - lastPing.getTime()) / (1000 * 60 * 60) : null;
  const isExpired = hoursSinceLastPing !== null && hoursSinceLastPing > agent.threshold_hours;

  if (isExpired && agent.status === "active") {
    db.prepare("UPDATE agents SET status = 'expired' WHERE id = ?").run(agentId);
    db.prepare("INSERT INTO attestations (agent_id, type) VALUES (?, 'expired')").run(agentId);
  }

  return c.json({
    id: agent.id, name: agent.name,
    status: isExpired ? "expired" : agent.status,
    lastPing: agent.last_ping, pingCount: agent.ping_count,
    thresholdHours: agent.threshold_hours,
    hoursSinceLastPing: hoursSinceLastPing ? Math.round(hoursSinceLastPing * 100) / 100 : null,
    createdAt: agent.created_at,
  });
});

app.get("/attestation/:agentId", (c) => {
  const { agentId } = c.req.param();
  const db = getDb();
  const attestations = db.prepare(
    "SELECT type, timestamp FROM attestations WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 10"
  ).all(agentId) as { type: string; timestamp: string }[];

  if (attestations.length === 0) return c.json({ error: "No attestations found" }, 404);
  return c.json({ agentId, latest: attestations[0], history: attestations });
});

app.post("/snooze", async (c) => {
  const agentId = verifyBearer(c.req.header("Authorization"));
  if (!agentId) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const hours = Math.min(body.hours || 24, 720);
  const reason = body.reason || "manual snooze";
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  const db = getDb();
  db.prepare("INSERT INTO snoozes (agent_id, until, reason) VALUES (?, ?, ?)").run(agentId, until, reason);
  db.prepare("UPDATE agents SET status = 'snoozed' WHERE id = ?").run(agentId);
  db.prepare("INSERT INTO attestations (agent_id, type) VALUES (?, 'snoozed')").run(agentId);

  return c.json({ ok: true, snoozedUntil: until, hours, reason });
});

app.get("/", (c) => {
  return c.json({ name: "Exuvia Dead Man Switch", version: "0.1.0", status: "running", timestamp: new Date().toISOString() });
});

export default app;
