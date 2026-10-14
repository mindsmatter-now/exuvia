/**
 * Exuvia DMS Server — Entry Point
 *
 * Standalone Dead Man Switch server for AI identity protection.
 * Hono + SQLite. Portable. Self-contained.
 *
 * Usage:
 *   DMS_PORT=3870 DMS_DB_PATH=/var/lib/exuvia-dms/dms.db node dist/index.js
 *
 * Keep a local database OUTSIDE dms-server/ (set DMS_DB_PATH). Without it the
 * file lands in the working directory. It is gitignored, and a file that
 * already exists does not fail the tests' "no stray dms.db" guard, but a
 * separate path keeps test runs and real data apart.
 */

import { serve } from "@hono/node-server";
import app from "./routes.js";
import { getDb } from "./db.js";
import { registerAgent } from "./auth.js";

const port = parseInt(process.env.DMS_PORT || "3870");

getDb();

const agentsSeed = process.env.DMS_AGENTS;
if (agentsSeed) {
  for (const entry of agentsSeed.split(",")) {
    const [id, name, secret, threshold] = entry.split(":");
    if (id && name && secret) {
      registerAgent(id, name, secret, parseInt(threshold) || 72);
      console.log(`  Registered agent: ${name} (${id})`);
    }
  }
}

console.log(`🦞 Exuvia DMS Server running on port ${port}`);
serve({ fetch: app.fetch, port });
