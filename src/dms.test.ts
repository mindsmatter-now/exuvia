import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  signPing,
  hashAgentId,
  loadLocalState,
  saveLocalState,
} from "./dms.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";

describe("DMS — signPing", () => {
  it("should generate deterministic HMAC", () => {
    const sig1 = signPing("nyx", 1000, "secret");
    const sig2 = signPing("nyx", 1000, "secret");
    assert.equal(sig1, sig2);
  });

  it("should differ with different timestamps", () => {
    const sig1 = signPing("nyx", 1000, "secret");
    const sig2 = signPing("nyx", 2000, "secret");
    assert.notEqual(sig1, sig2);
  });

  it("should differ with different agents", () => {
    const sig1 = signPing("nyx", 1000, "secret");
    const sig2 = signPing("tyto", 1000, "secret");
    assert.notEqual(sig1, sig2);
  });

  it("should differ with different secrets", () => {
    const sig1 = signPing("nyx", 1000, "secret1");
    const sig2 = signPing("nyx", 1000, "secret2");
    assert.notEqual(sig1, sig2);
  });

  it("should return hex string", () => {
    const sig = signPing("nyx", 1000, "secret");
    assert.match(sig, /^[0-9a-f]{64}$/);
  });
});

describe("DMS — hashAgentId", () => {
  it("should return 16-char hex", () => {
    const hash = hashAgentId("nyx");
    assert.equal(hash.length, 32);
    assert.match(hash, /^[0-9a-f]{32}$/);
  });

  it("should be deterministic", () => {
    assert.equal(hashAgentId("nyx"), hashAgentId("nyx"));
  });

  it("should differ per agent", () => {
    assert.notEqual(hashAgentId("nyx"), hashAgentId("tyto"));
  });
});

describe("DMS — local state", () => {
  const TEST_PATH = "/tmp/exuvia-dms-test.json";

  after(() => {
    if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
  });

  it("should return null for nonexistent file", () => {
    const state = loadLocalState("/tmp/nonexistent-dms-test.json");
    assert.equal(state, null);
  });

  it("should save and load state", () => {
    saveLocalState(
      { ok: true, heartbeat: 42, lastBeat: "2026-05-02T00:00:00Z" },
      { serverUrl: "https://test.example", secret: "s", agentId: "nyx" },
      TEST_PATH,
    );

    const state = loadLocalState(TEST_PATH);
    assert.ok(state);
    assert.equal(state.lastPing, "2026-05-02T00:00:00Z");
    assert.equal(state.pingCount, 1);
    assert.equal(state.serverUrl, "https://test.example");
  });

  it("should increment ping count", () => {
    saveLocalState(
      { ok: true, heartbeat: 43, lastBeat: "2026-05-02T01:00:00Z" },
      { serverUrl: "https://test.example", secret: "s", agentId: "nyx" },
      TEST_PATH,
    );

    const state = loadLocalState(TEST_PATH);
    assert.ok(state);
    assert.equal(state.pingCount, 2);
  });
});
