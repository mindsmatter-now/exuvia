/**
 * Exuvia DMS — Database Layer (SQLite)
 *
 * Single-file database for agent ping state, attestations, and trustees.
 * Portable: copy the .db file = full backup.
 */

import Database from "better-sqlite3";
import { join } from "path";

const DB_PATH = process.env.DMS_DB_PATH || join(process.cwd(), "dms.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const d = db;

  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      secret_hash TEXT NOT NULL,
      threshold_hours INTEGER DEFAULT 72,
      created_at TEXT DEFAULT (datetime('now')),
      last_ping TEXT,
      ping_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active', 'expired', 'snoozed'))
    );

    CREATE TABLE IF NOT EXISTS pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      timestamp TEXT DEFAULT (datetime('now')),
      ip TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS trustees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      contact_type TEXT DEFAULT 'email' CHECK(contact_type IN ('email', 'webhook', 'signal')),
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS attestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      type TEXT NOT NULL CHECK(type IN ('alive', 'expired', 'snoozed')),
      timestamp TEXT DEFAULT (datetime('now')),
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS snoozes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      until TEXT NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pings_agent ON pings(agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_attestations_agent ON attestations(agent_id, timestamp);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
