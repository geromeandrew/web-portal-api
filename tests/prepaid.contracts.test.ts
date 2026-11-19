import { describe, expect, it, vi } from "vitest";
import { type S3Client } from "@aws-sdk/client-s3";
import type { SFNClient } from "@aws-sdk/client-sfn";
import type { STSClient } from "@aws-sdk/client-sts";
import { AwsStepFunctionsRunner } from "../src/stepFunctionsRunner.js";
import { PrepaidStorage } from "../src/modules/prepaid/infrastructure/prepaidStorage.js";
import {
  encodeDelimited,
  integrationSchema,
  sourceCodeSchema,
  upstreamManifestSchema,
  matchesSourceName,
  sourceFileRequirement,
} from "../src/modules/prepaid/domain/contracts.js";

describe("Prepaid delivery archive", () => {
  const prefix = "prepaid_reclass/outbound/sftp-pushed/";
  const filename = "txPrepaid_JV_EGSel.txt";
  const start = "2026-11-19T13:00:00Z";
  const end = "2026-11-19T13:05:00Z";
  const fresh = new Date("2026-11-19T13:03:00Z");
  const object = (folder: string, name = filename, LastModified = fresh) => ({
    Key: prefix + folder + "/" + name,
    LastModified,
  });
  const storage = (send: ReturnType<typeof vi.fn>) =>
    new PrepaidStorage({ send } as Pick<S3Client, "send">, "test");

  it.each(["20261119-1303", "20261119_1303"])(
    "accepts a fresh archive under %s",
    async (folder) => {
      const expected = object(folder);
      const send = vi.fn().mockResolvedValue({
        Contents: [
          object("20261119_1259", filename, new Date("2026-11-19T12:59:59Z")),
          object("20261119_1306", filename, new Date("2026-11-19T13:06:00Z")),
          object(folder, "txPrepaid_JV_SGSel.txt"),
          object(folder + "/nested"),
          object("20261119.1303"),
          expected,
        ],
      });
      await expect(
        storage(send).deliveredJournalKey(prefix, filename, start, end),
      ).resolves.toBe(expected.Key);
    },
  );

  it("rejects two matching archives even across different pages and formats", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [object("20261119-1303")],
        NextContinuationToken: "next",
      })
      .mockResolvedValueOnce({ Contents: [object("20261119_1304")] });
    await expect(
      storage(send).deliveredJournalKey(prefix, filename, start, end),
    ).rejects.toThrow("Multiple delivered journals match this operation.");
    expect(send.mock.calls[1][0].input.ContinuationToken).toBe("next");
  });
});

describe("Prepaid external contracts", () => {
  it("accepts only verified legacy Call Card aliases without changing native filenames", () => {
    expect(matchesSourceName("callcard_eg", "EG CALLCARD.xlsx")).toBe(true);
    expect(matchesSourceName("callcard_sg", "sg callcard.XLSX")).toBe(true);
    expect(matchesSourceName("callcard_eg", "CALLCARD_EG.XLSX")).toBe(true);
    expect(matchesSourceName("callcard_eg", "SG CALLCARD.xlsx")).toBe(false);
    for (const name of [
      "../EG CALLCARD.xlsx",
      "EG CALLCARD.xls",
      "EG CALLCARD (1).xlsx",
      "EG CALLCARD.xlsx.exe",
    ])
      expect(matchesSourceName("callcard_eg", name)).toBe(false);
    expect(sourceFileRequirement("callcard_eg")).toEqual({
      code: "callcard_eg",
      fileName: "CALLCARD_EG.XLSX",
      acceptedFileNames: ["CALLCARD_EG.XLSX", "EG CALLCARD.xlsx"],
    });
    expect(sourceFileRequirement("ke24")).toEqual({
      code: "ke24",
      fileName: "KE24.XLSX",
    });
  });
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
