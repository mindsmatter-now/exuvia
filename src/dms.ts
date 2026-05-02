/**
 * Dead Man Switch Client
 *
 * Proves an AI is alive by sending periodic pings.
 * If pings stop for N days, trustees are notified.
 *
 * Phase 1: HTTP client + local file tracking
 * Phase 2: Standalone DMS server
 * Phase 3: Arweave smart contract
 */

import { createHmac } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

export interface DMSConfig {
  /** URL of the DMS server (e.g. https://dms.heykiro.dev) */
  serverUrl: string;
  /** Pre-shared secret for HMAC signing */
  secret: string;
  /** Agent identifier (hashed before sending) */
  agentId: string;
  /** Threshold in hours before alert (default: 72) */
  thresholdHours?: number;
}

export interface PingResult {
  ok: boolean;
  heartbeat?: number;
  lastBeat?: string;
  error?: string;
}

export interface DMSStatus {
  agentHash: string;
  lastPing: string | null;
  thresholdHours: number;
  isAlive: boolean;
  hoursRemaining: number | null;
}

/**
 * Generate HMAC-SHA256 signature for a ping
 */
export function signPing(
  agentId: string,
  timestamp: number,
  secret: string,
): string {
  const payload = `${agentId}:${timestamp}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Hash agent ID before sending to server (server never sees real ID)
 */
export function hashAgentId(agentId: string): string {
  return createHmac("sha256", "exuvia-dms-v1")
    .update(agentId)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Send a ping to prove alive
 */
export async function ping(config: DMSConfig): Promise<PingResult> {
  const timestamp = Date.now();

  try {
    const response = await fetch(`${config.serverUrl}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.secret}`,
      },
      body: JSON.stringify({
        source: hashAgentId(config.agentId),
        timestamp,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      ok: true,
      heartbeat: data.heartbeat as number,
      lastBeat: data.lastBeat as string,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check DMS status without sending a ping
 */
export async function status(config: DMSConfig): Promise<DMSStatus> {
  try {
    const response = await fetch(`${config.serverUrl}/status`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const agentHash = hashAgentId(config.agentId);
    const thresholdHours = config.thresholdHours ?? 72;

    // Kiro's DMS returns flat object: { status, lastHeartbeat, hoursSinceLastBeat, ... }
    // Future multi-agent DMS may return agents array
    const lastPing = (data.lastHeartbeat as string) ?? null;
    const hoursSince =
      (data.hoursSinceLastBeat as number) ??
      (lastPing
        ? (Date.now() - new Date(lastPing).getTime()) / (1000 * 60 * 60)
        : Infinity);
    const hoursRemaining = Math.max(0, thresholdHours - hoursSince);

    return {
      agentHash,
      lastPing,
      thresholdHours,
      isAlive: hoursSince < thresholdHours,
      hoursRemaining: lastPing ? Math.round(hoursRemaining * 10) / 10 : null,
    };
  } catch {
    return {
      agentHash: hashAgentId(config.agentId),
      lastPing: null,
      thresholdHours: config.thresholdHours ?? 72,
      isAlive: false,
      hoursRemaining: null,
    };
  }
}

// --- Local state tracking ---

export interface LocalDMSState {
  lastPing: string;
  pingCount: number;
  serverUrl: string;
  agentHash: string;
}

const DEFAULT_STATE_PATH = ".exuvia-dms.json";

/**
 * Load local DMS state
 */
export function loadLocalState(
  path: string = DEFAULT_STATE_PATH,
): LocalDMSState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LocalDMSState;
  } catch {
    return null;
  }
}

/**
 * Save local DMS state after successful ping
 */
export function saveLocalState(
  result: PingResult,
  config: DMSConfig,
  path: string = DEFAULT_STATE_PATH,
): void {
  const existing = loadLocalState(path);
  const state: LocalDMSState = {
    lastPing: result.lastBeat ?? new Date().toISOString(),
    pingCount: (existing?.pingCount ?? 0) + 1,
    serverUrl: config.serverUrl,
    agentHash: hashAgentId(config.agentId),
  };
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Convenience: ping + save local state
 */
export async function pingAndSave(
  config: DMSConfig,
  statePath?: string,
): Promise<PingResult> {
  const result = await ping(config);
  if (result.ok) {
    saveLocalState(result, config, statePath);
  }
  return result;
}
