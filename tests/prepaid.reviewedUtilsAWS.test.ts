import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  sourceIsolationAssets,
  isReviewedSourceAsset,
} from "../src/modules/prepaid/domain/sourceIsolation.js";
import { AwsSourceJobInspector } from "../src/modules/prepaid/infrastructure/sourceJobInspector.js";

const fixture = new URL(
  "./fixtures/prepaid-reviewed-utilsaws.py",
  import.meta.url,
);
const runtime =
  process.env.PREPAID_PYTHON_EXECUTABLE ||
  (process.platform === "win32"
    ? ".venv-prepaid/Scripts/python.exe"
    : ".venv-prepaid/bin/python");

it("pins the exact helper whose extraction operations were reviewed", () => {
  expect(createHash("sha256").update(readFileSync(fixture)).digest("hex")).toBe(
    sourceIsolationAssets["imports/UtilsAWS.py"],
  );
});

it("accepts all reviewed helper versions while rejecting changed or misplaced content", () => {
  const bytes = readFileSync(fixture);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  expect(isReviewedSourceAsset("imports/UtilsAWS.py", checksum)).toBe(true);
  expect(
    isReviewedSourceAsset(
      "imports/UtilsAWS.py",
      "c8d8bd2327d57ec1a725573d7300cf61f675e212ceca261977a6904230b30e91",
    ),
  ).toBe(true);
  expect(
    isReviewedSourceAsset(
      "imports/UtilsAWS.py",
      "916dfe0f7929869d5445917e488380cc4df2082aa2b04c11e7d5232dedc74162",
    ),
  ).toBe(true);
  expect(
    isReviewedSourceAsset(
      "imports/UtilsAWS.py",
      "e0ddd9523c1a86753c907ce84d19e0b6d16f6892a4d7f45216147b6cb8ea117f",
    ),
  ).toBe(true);
  expect(
    isReviewedSourceAsset(
      "imports/UtilsAWS.py",
      createHash("sha256")
        .update(bytes)
        .update("\n# unreviewed change")
        .digest("hex"),
    ),
  ).toBe(false);
  expect(isReviewedSourceAsset("imports/Utils.py", checksum)).toBe(false);
  expect(isReviewedSourceAsset("imports/unreviewed.py", checksum)).toBe(false);
});

it("blocks unreviewed content and identifies its exact version for support", async () => {
  const bytes = Buffer.from("unreviewed shared implementation");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const inspector = new AwsSourceJobInspector(
    {} as any,
    {} as any,
    async () => bytes,
  );
  await expect(inspector.verifyIsolation()).rejects.toMatchObject({
    message: expect.stringContaining(checksum.slice(0, 12)),
    details: {
      sourceAssetSha256: checksum,
      sourceAssetExpectedSha256: expect.any(String),
      sourceAssetBucket: expect.any(String),
      sourceAssetKey: expect.any(String),
    },
  });
});

describe.skipIf(!existsSync(runtime))(
  "Reviewed extraction helper behavior",
  () => {
    it("preserves copy-only, file-scoped moves, failure handling and exact-name lookup", () => {
      const result = spawnSync(
        runtime,
        ["tests/prepaid_reviewed_utilsaws_test.py"],
        {
          encoding: "utf8",
          timeout: 15000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Ran 8 tests");
    });
  },
);
