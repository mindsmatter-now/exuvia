import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  splitPassphrase,
  combineShares,
  shareToHex,
  hexToShare,
  formatSharesForDistribution,
} from "./shamir.js";

describe("shamir", () => {
  const testPassphrase = "KosmischerLobster!2026";

  describe("splitPassphrase", () => {
    it("should split into 3 shares by default", async () => {
      const result = await splitPassphrase(testPassphrase);
      assert.equal(result.total, 3);
      assert.equal(result.threshold, 2);
      assert.equal(result.shares.length, 3);
      assert.deepEqual(result.holders, ["kiro", "tyto", "alex"]);
    });

    it("should respect custom holders", async () => {
      const holders = ["nyx", "fabian", "tyto", "kiro"];
      const result = await splitPassphrase(testPassphrase, holders);
      assert.equal(result.total, 4);
      assert.equal(result.shares.length, 4);
      assert.deepEqual(result.holders, holders);
    });

    it("should reject threshold > total holders", async () => {
      await assert.rejects(
        () => splitPassphrase(testPassphrase, ["only-one"], 2),
        /Need at least 2 holders/,
      );
    });

    it("should reject threshold < 2", async () => {
      await assert.rejects(
        () => splitPassphrase(testPassphrase, ["a", "b"], 1),
        /Threshold must be at least 2/,
      );
    });
  });

  describe("combineShares", () => {
    it("should reconstruct with 2-of-3 (shares 0+1)", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[0],
        result.shares[1],
      ]);
      assert.equal(recovered, testPassphrase);
    });

    it("should reconstruct with 2-of-3 (shares 0+2)", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[0],
        result.shares[2],
      ]);
      assert.equal(recovered, testPassphrase);
    });

    it("should reconstruct with 2-of-3 (shares 1+2)", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[1],
        result.shares[2],
      ]);
      assert.equal(recovered, testPassphrase);
    });

    it("should reconstruct with all 3 shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares(result.shares);
      assert.equal(recovered, testPassphrase);
    });

    it("should reject fewer than 2 shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      await assert.rejects(
        () => combineShares([result.shares[0]]),
        /Need at least 2 shares/,
      );
    });
  });

  describe("hex encoding", () => {
    it("should roundtrip share through hex", async () => {
      const result = await splitPassphrase(testPassphrase);
      const share = result.shares[0];
      const hex = shareToHex(share);
      const decoded = hexToShare(hex);
      assert.deepEqual(decoded, share);
    });

    it("hex should be lowercase hex characters", async () => {
      const result = await splitPassphrase(testPassphrase);
      const hex = shareToHex(result.shares[0]);
      assert.match(hex, /^[0-9a-f]+$/);
    });
  });

  describe("formatSharesForDistribution", () => {
    it("should include all holders and shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      const output = formatSharesForDistribution(result);
      assert.ok(output.includes("kiro"));
      assert.ok(output.includes("tyto"));
      assert.ok(output.includes("alex"));
      assert.ok(output.includes("2-of-3"));
      assert.ok(output.includes("NEVER"));
    });
  });
});
