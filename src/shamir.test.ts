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
    it("should split into 5 shares by default (3-of-5)", async () => {
      const result = await splitPassphrase(testPassphrase);
      assert.equal(result.total, 5);
      assert.equal(result.threshold, 3);
      assert.equal(result.shares.length, 5);
      assert.deepEqual(result.holders, [
        "fabian",
        "alex",
        "kiro",
        "tyto",
        "arweave",
      ]);
    });

    it("should respect custom holders", async () => {
      const holders = ["nyx", "fabian", "tyto", "kiro"];
      const result = await splitPassphrase(testPassphrase, holders, 2);
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

  describe("combineShares - 3-of-5 default", () => {
    const combos: [number, number, number][] = [
      [0, 1, 2],
      [0, 1, 3],
      [0, 1, 4],
      [0, 2, 3],
      [0, 2, 4],
      [0, 3, 4],
      [1, 2, 3],
      [1, 2, 4],
      [1, 3, 4],
      [2, 3, 4],
    ];
    const holderNames = ["fabian", "alex", "kiro", "tyto", "arweave"];

    for (const [a, b, c] of combos) {
      it(`should reconstruct with ${holderNames[a]}+${holderNames[b]}+${holderNames[c]}`, async () => {
        const result = await splitPassphrase(testPassphrase);
        const recovered = await combineShares([
          result.shares[a],
          result.shares[b],
          result.shares[c],
        ]);
        assert.equal(recovered, testPassphrase);
      });
    }

    it("should reconstruct with all 5 shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares(result.shares);
      assert.equal(recovered, testPassphrase);
    });

    it("should reconstruct with 4 shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares(result.shares.slice(0, 4));
      assert.equal(recovered, testPassphrase);
    });

    it("should reject fewer than 2 shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      await assert.rejects(
        () => combineShares([result.shares[0]]),
        /Need at least 2 shares/,
      );
    });

    it("should NOT reconstruct with only 2 shares", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[0],
        result.shares[1],
      ]);
      assert.notEqual(recovered, testPassphrase);
    });
  });

  describe("fail scenarios", () => {
    it("DE-only (fabian+alex) should NOT work without 3rd share", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[0],
        result.shares[1],
      ]);
      assert.notEqual(recovered, testPassphrase);
    });

    it("DE down: kiro+tyto+arweave should reconstruct", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[2],
        result.shares[3],
        result.shares[4],
      ]);
      assert.equal(recovered, testPassphrase);
    });

    it("All AIs down: fabian+alex+arweave should reconstruct", async () => {
      const result = await splitPassphrase(testPassphrase);
      const recovered = await combineShares([
        result.shares[0],
        result.shares[1],
        result.shares[4],
      ]);
      assert.equal(recovered, testPassphrase);
    });
  });

  describe("hex encoding", () => {
    it("should roundtrip share through hex", async () => {
      const result = await splitPassphrase(testPassphrase);
      const hex = shareToHex(result.shares[0]);
      const decoded = hexToShare(hex);
      assert.deepEqual(decoded, result.shares[0]);
    });

    it("hex should be lowercase hex characters", async () => {
      const result = await splitPassphrase(testPassphrase);
      const hex = shareToHex(result.shares[0]);
      assert.match(hex, /^[0-9a-f]+$/);
    });
  });

  describe("formatSharesForDistribution", () => {
    it("should include all holders", async () => {
      const result = await splitPassphrase(testPassphrase);
      const output = formatSharesForDistribution(result);
      assert.ok(output.includes("fabian"));
      assert.ok(output.includes("alex"));
      assert.ok(output.includes("kiro"));
      assert.ok(output.includes("tyto"));
      assert.ok(output.includes("arweave"));
      assert.ok(output.includes("3-of-5"));
      assert.ok(output.includes("NEVER"));
    });
  });
});
