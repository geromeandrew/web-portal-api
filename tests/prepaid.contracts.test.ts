import { describe, expect, it, vi } from "vitest";
import type { SFNClient } from "@aws-sdk/client-sfn";
import type { STSClient } from "@aws-sdk/client-sts";
import { AwsStepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import { PrepaidStorage } from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import {
  encodeDelimited,
  integrationSchema,
  sourceCodeSchema,
  upstreamManifestSchema,
} from "../src/modules/prepaid/domain/contracts.js";

describe("Prepaid external contracts", () => {
  it("recovers the same named AWS execution after a lost dispatch response", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("already started"), {
          name: "ExecutionAlreadyExists",
        }),
      )
      .mockResolvedValueOnce({
        input: '{"period":"2026-09"}',
        startDate: new Date("2026-10-06T00:00:00Z"),
        status: "RUNNING",
      });
    const sts = vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/test/test",
    });
    const runner = new AwsStepFunctionsRunner(
      { send } as unknown as Pick<SFNClient, "send">,
      { send: sts } as unknown as Pick<STSClient, "send">,
      "ap-southeast-1",
    );
    expect(
      (
        await runner.startExecution(
          "prepaid-test",
          { period: "2026-09" },
          "durable-job-name",
        )
      ).executionArn,
    ).toBe(
      "arn:aws:states:ap-southeast-1:123456789012:execution:prepaid-test:durable-job-name",
    );
    expect(send.mock.calls[0][0].input.name).toBe("durable-job-name");
  });
  it("rejects a named execution containing different input", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("exists"), { name: "ExecutionAlreadyExists" }),
      )
      .mockResolvedValueOnce({ input: "{}", status: "RUNNING" });
    const sts = vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/test/test",
    });
    const runner = new AwsStepFunctionsRunner(
      { send } as unknown as Pick<SFNClient, "send">,
      { send: sts } as unknown as Pick<STSClient, "send">,
      "ap-southeast-1",
    );
    await expect(
      runner.startExecution("prepaid-test", { period: "2026-09" }, "same-name"),
    ).rejects.toThrow("different input");
  });
  it("quotes delimited fields and preserves decimal strings and encoding", () => {
    const bytes = encodeDelimited(
      [{ a: "1.00", b: 'quoted,"cell"\nnext' }],
      ["a", "b"],
      ",",
      "\r\n",
      "utf8",
    );
    expect(bytes.toString()).toBe('a,b\r\n1.00,"quoted,""cell""\nnext"\r\n');
    expect(
      encodeDelimited(
        [{ a: "112.00" }],
        ["a"],
        "\t",
        "\r\n",
        "utf16le",
      ).toString("utf16le"),
    ).toBe("a\r\n112.00\r\n");
  });
  it("refuses cross-run paths and unapproved delivery configuration", () => {
    const storage = new PrepaidStorage({ send: vi.fn() } as any, "test");
    expect(() =>
      storage.assertKey(
        "prepaid_reclass/runs/other/export.txt",
        storage.prefix("mine"),
      ),
    ).toThrow();
    expect(() => storage.assertKey("prefix/../secret", "prefix/")).toThrow();
    expect(integrationSchema.safeParse({}).success).toBe(false);
    expect(sourceCodeSchema.safeParse("308_01").success).toBe(true);
    expect(sourceCodeSchema.safeParse("308_invalid").success).toBe(false);
    expect(
      upstreamManifestSchema.safeParse({ contractVersion: 1, datasets: [] })
        .success,
    ).toBe(false);
  });
});
