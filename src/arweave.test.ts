import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TESTNET_CONFIG } from "./arweave.js";

describe("arweave module", () => {
  it("should export TESTNET_CONFIG with correct structure", () => {
    assert.equal(TESTNET_CONFIG.host, "testnet.redstone.tools");
    assert.equal(TESTNET_CONFIG.port, 443);
    assert.equal(TESTNET_CONFIG.protocol, "https");
    assert.ok(TESTNET_CONFIG.timeout! > 0);
  });

  it("should throw readable error for missing wallet", async () => {
    const { upload } = await import("./arweave.js");
    await assert.rejects(
      () => upload(Buffer.from("test"), "/nonexistent/wallet.json"),
      (err: Error) => {
        assert.match(err.message, /wallet not found/i);
        return true;
      },
    );
  });

  it("should throw readable error for invalid wallet JSON", async () => {
    const { writeFileSync, unlinkSync } = await import("fs");
    const tmpPath = "/tmp/bad-wallet-test.json";
    writeFileSync(tmpPath, "not json{{{");
    const { upload } = await import("./arweave.js");
    try {
      await assert.rejects(
        () => upload(Buffer.from("test"), tmpPath),
        (err: Error) => {
          assert.match(err.message, /not valid JSON/i);
          return true;
        },
      );
    } finally {
      unlinkSync(tmpPath);
    }
  });
});
