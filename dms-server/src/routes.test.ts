/**
 * Exuvia DMS Server — Route Tests
 *
 * Tests all API endpoints: /ping, /status, /attestation, /snooze, /
 * Uses in-memory SQLite for isolation.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import app from "./routes.js";
import { getDb, closeDb } from "./db.js";
import { registerAgent, hashSecret } from "./auth.js";

// ── Test Helpers ───────────────────────────────────────────────────

const TEST_AGENT_ID = "test-nyx";
const TEST_AGENT_NAME = "Nyx";
const TEST_SECRET = "test-secret-12345";

async function request(
  method: string,
  path: string,
  opts: { body?: any; auth?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.auth) headers["Authorization"] = `Bearer ${opts.auth}`;
  if (opts.body) headers["Content-Type"] = "application/json";

  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const res = await app.fetch(req);
  const json = await res.json();
  return { status: res.status, json };
}

// ── Setup ──────────────────────────────────────────────────────────

// Set in-memory DB for tests
process.env.DMS_DB_PATH = ":memory:";

describe("DMS Server Routes", () => {
  // Guard: the tests must not touch a real dms.db next to the code, neither
  // create one nor write into one a developer keeps here on purpose (that
  // in-place write is how a snooze leaked into the next run). Fingerprint
  // the file and its WAL/SHM siblings before, compare after (Tyto, #24).
  const dbFiles = ["dms.db", "dms.db-wal", "dms.db-shm"].map((f) =>
    join(process.cwd(), f),
  );
  const fingerprint = () =>
    dbFiles
      .map((f) =>
        existsSync(f)
          ? `${f}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`
          : `${f}:-`,
      )
      .join("\n");
  let before0 = "";

  before(() => {
    before0 = fingerprint();
    // Initialize DB + register test agent
    getDb();
    registerAgent(TEST_AGENT_ID, TEST_AGENT_NAME, TEST_SECRET, 72);
  });

  after(() => {
    closeDb();
    // The tests must never write a real database next to the code: a stray
    // dms.db leaked snoozes into the next run (Tyto, review #23). CI runs
    // from dms-server/, so cwd is the folder to check.
    assert.equal(
      fingerprint(),
      before0,
      "tests created or wrote a real dms.db (or its -wal/-shm)",
    );
  });

  // ── Health Check ───────────────────────────────────────────────

  describe("GET /", () => {
    it("should return server info", async () => {
      const { status, json } = await request("GET", "/");
      assert.equal(status, 200);
      assert.equal(json.name, "Exuvia Dead Man Switch");
      assert.equal(json.status, "running");
      assert.ok(json.timestamp);
    });
  });

  // ── Ping ───────────────────────────────────────────────────────

  describe("POST /ping", () => {
    it("should accept valid ping", async () => {
      const { status, json } = await request("POST", "/ping", {
        auth: TEST_SECRET,
        body: { source: "nyx" },
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.ok(json.pingCount >= 1);
      assert.ok(json.lastBeat);
      assert.equal(json.thresholdHours, 72);
    });

    it("should increment ping count", async () => {
      const r1 = await request("POST", "/ping", {
        auth: TEST_SECRET,
        body: {},
      });
      const r2 = await request("POST", "/ping", {
        auth: TEST_SECRET,
        body: {},
      });
      assert.ok(r2.json.pingCount > r1.json.pingCount);
    });

    it("should reject without auth", async () => {
      const { status, json } = await request("POST", "/ping", {
        body: { source: "nyx" },
      });
      assert.equal(status, 401);
      assert.equal(json.error, "Unauthorized");
    });

    it("should reject with wrong secret", async () => {
      const { status } = await request("POST", "/ping", {
        auth: "wrong-secret",
        body: {},
      });
      assert.equal(status, 401);
    });

    it("should handle empty body gracefully", async () => {
      const { status, json } = await request("POST", "/ping", {
        auth: TEST_SECRET,
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
    });
  });

  // ── Status ─────────────────────────────────────────────────────

  describe("GET /status/:agentId", () => {
    it("should return agent status", async () => {
      // Ensure at least one ping
      await request("POST", "/ping", {
        auth: TEST_SECRET,
        body: {},
      });

      const { status, json } = await request("GET", `/status/${TEST_AGENT_ID}`);
      assert.equal(status, 200);
      assert.equal(json.id, TEST_AGENT_ID);
      assert.equal(json.name, TEST_AGENT_NAME);
      assert.equal(json.status, "active");
      assert.ok(json.lastPing);
      assert.ok(json.pingCount >= 1);
      assert.equal(json.thresholdHours, 72);
      assert.ok(json.hoursSinceLastPing !== null);
      assert.ok(json.hoursSinceLastPing < 1); // just pinged
    });

    it("a ping 0 ms ago reports 0 hours, not null", async () => {
      // Freeze the clock at the stored ping time: exactly 0 hours since.
      const t = Date.now(); // real "now", so a later real-clock test never sees a 72 h old ping (Kiro)
      getDb()
        .prepare("UPDATE agents SET last_ping = ? WHERE id = ?")
        .run(new Date(t).toISOString(), TEST_AGENT_ID);
      const realNow = Date.now;
      Date.now = () => t;
      try {
        const { json } = await request("GET", `/status/${TEST_AGENT_ID}`);
        assert.strictEqual(json.hoursSinceLastPing, 0);
      } finally {
        Date.now = realNow;
      }
    });

    it("a ping time in the future (clock skew) reports 0, not negative", async () => {
      const t = Date.now(); // real "now", so a later real-clock test never sees a 72 h old ping (Kiro)
      getDb()
        .prepare("UPDATE agents SET last_ping = ? WHERE id = ?")
        .run(new Date(t + 60_000).toISOString(), TEST_AGENT_ID);
      const realNow = Date.now;
      Date.now = () => t;
      try {
        const { json } = await request("GET", `/status/${TEST_AGENT_ID}`);
        assert.strictEqual(json.hoursSinceLastPing, 0);
      } finally {
        Date.now = realNow;
      }
    });

    it("should return 404 for unknown agent", async () => {
      const { status, json } = await request("GET", "/status/unknown-agent");
      assert.equal(status, 404);
      assert.equal(json.error, "Agent not found");
    });
  });

  // ── Attestation ────────────────────────────────────────────────

  describe("GET /attestation/:agentId", () => {
    it("should return attestation history", async () => {
      const { status, json } = await request(
        "GET",
        `/attestation/${TEST_AGENT_ID}`,
      );
      assert.equal(status, 200);
      assert.equal(json.agentId, TEST_AGENT_ID);
      assert.ok(json.latest);
      assert.equal(json.latest.type, "alive");
      assert.ok(Array.isArray(json.history));
      assert.ok(json.history.length >= 1);
    });

    it("should return 404 for unknown agent", async () => {
      const { status, json } = await request(
        "GET",
        "/attestation/unknown-agent",
      );
      assert.equal(status, 404);
    });
  });

  // ── Snooze ─────────────────────────────────────────────────────

  describe("POST /snooze", () => {
    it("should accept snooze with hours and reason", async () => {
      const { status, json } = await request("POST", "/snooze", {
        auth: TEST_SECRET,
        body: { hours: 24, reason: "maintenance" },
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.hours, 24);
      assert.equal(json.reason, "maintenance");
      assert.ok(json.snoozedUntil);
    });

    it("should cap snooze at 720 hours (30 days)", async () => {
      const { status, json } = await request("POST", "/snooze", {
        auth: TEST_SECRET,
        body: { hours: 9999 },
      });
      assert.equal(status, 200);
      assert.equal(json.hours, 720);
    });

    it("should default to 24 hours", async () => {
      const { status, json } = await request("POST", "/snooze", {
        auth: TEST_SECRET,
        body: {},
      });
      assert.equal(status, 200);
      assert.equal(json.hours, 24);
    });

    it("should reject without auth", async () => {
      const { status } = await request("POST", "/snooze", {
        body: { hours: 24 },
      });
      assert.equal(status, 401);
    });

    it("should update agent status to snoozed", async () => {
      await request("POST", "/snooze", {
        auth: TEST_SECRET,
        body: { hours: 24 },
      });

      const { json } = await request("GET", `/status/${TEST_AGENT_ID}`);
      assert.equal(json.status, "snoozed");

      // Reset to active with a ping
      await request("POST", "/ping", {
        auth: TEST_SECRET,
        body: {},
      });
    });

    it("F1: snoozed agent should NOT be marked expired", async () => {
      const db = getDb();

      // Clear any existing snoozes from previous tests
      db.prepare("DELETE FROM snoozes WHERE agent_id = ?").run(TEST_AGENT_ID);

      // Set last_ping to far in the past (beyond threshold)
      const oldDate = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h ago
      db.prepare(
        "UPDATE agents SET last_ping = ?, status = 'active' WHERE id = ?",
      ).run(oldDate, TEST_AGENT_ID);

      // Without snooze, should be expired
      const r1 = await request("GET", `/status/${TEST_AGENT_ID}`);
      assert.equal(r1.json.status, "expired");

      // Now snooze and reset status
      db.prepare("UPDATE agents SET status = 'snoozed' WHERE id = ?").run(
        TEST_AGENT_ID,
      );
      await request("POST", "/snooze", {
        auth: TEST_SECRET,
        body: { hours: 48 },
      });

      // With active snooze, should stay snoozed even though lastPing > threshold
      const r2 = await request("GET", `/status/${TEST_AGENT_ID}`);
      assert.equal(r2.json.status, "snoozed");
      assert.ok(r2.json.snoozedUntil);

      // Reset for other tests
      await request("POST", "/ping", {
        auth: TEST_SECRET,
        body: {},
      });
    });
  });
});

// ── Auth Unit Tests ──────────────────────────────────────────────

describe("Auth Module", () => {
  it("should hash secrets consistently", () => {
    const h1 = hashSecret("test");
    const h2 = hashSecret("test");
    assert.equal(h1, h2);
  });

  it("should produce different hashes for different secrets", () => {
    const h1 = hashSecret("secret-a");
    const h2 = hashSecret("secret-b");
    assert.notEqual(h1, h2);
  });

  it("should produce 64-char hex hash", () => {
    const h = hashSecret("test");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe("db handle", () => {
  it("getDb() after closeDb() opens a fresh connection", () => {
    process.env.DMS_DB_PATH = ":memory:";
    getDb();
    closeDb();
    const d = getDb();
    assert.equal(d.open, true);
    assert.deepEqual(d.prepare("SELECT 1 AS x").get(), { x: 1 });
    closeDb();
  });
});
