import { describe, expect, it, vi } from "vitest";
import { AwsSourceJobInspector } from "../src/modules/prepaid/infrastructure/sourceJobInspector.js";
import {
  nativeJobColumnArguments,
  nativeJobFixture,
} from "./fixtures/prepaidSource.js";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";

describe("Read-only existing Glue job inspection", () => {
  it("checks the deployed sandbox spreadsheet release at its real S3 key", async () => {
    const fixture = nativeJobFixture(10);
    const key =
      "glue/dv-v0.0.1/prepaid_reclass/a27a81d36f2eb42c/GlueSpreadsheetWildcard.py";
    fixture.command.ScriptLocation = `s3://isg-esatp-rcc-scripts-os/${key}`;
    fixture.arguments["--folder_location"] =
      "isg-esatp-rcc-storage-os/prepaid_reclass/";
    fixture.arguments["--input_file_name"] = "KE24.xlsx";
    fixture.arguments["--target_table"] = "sdbtdir1_prepaid_dbo.dcKE24";
    const send = vi.fn(async () => ({
      Job: { Command: fixture.command, DefaultArguments: fixture.arguments },
    }));
    const read = vi.fn(async () => Buffer.from("unreviewed replacement"));
    const inspector = new AwsSourceJobInspector(
      { send } as any,
      {} as any,
      read,
    );
    await expect(
      inspector.verify("ke24", "isg-esatp-dv", "isg-esatp-rcc-storage-os"),
    ).rejects.toThrow(
      "Shared Glue implementation changed: scripts/GlueSpreadsheetWildcard.py",
    );
    expect(read).toHaveBeenCalledWith(key, "isg-esatp-rcc-scripts-os");
  });
  const cases = (Object.keys(sourceWorkflows) as SourceWorkflow[]).flatMap(
    (workflow) =>
      sourceWorkflows[workflow].jobs.map((number, index) => ({
        workflow,
        number,
        index,
      })),
  );
  it.each(cases)(
    "rejects parsing/load drift for extractor $number",
    async ({ workflow, number }) => {
      const mapping = sourceWorkflows[workflow];
      const snapshot = nativeJobFixture(number);
      const mutations = [
        ...Object.keys(snapshot.arguments)
          .filter((key) => key !== "--move_to_success")
          .map((key) => ({ key, value: "CHANGED" })),
        ...[
          "--audit_table",
          "--passed_parameter",
          "--allowed_files",
          "--portal_validate",
          "--scriptLocation",
        ].map((key) => ({ key, value: "unexpected" })),
        { key: "--valid_columns", value: "wrong_column" },
        { key: "--target_sheet", value: "wrong_sheet" },
        { key: "--skip_header_lines", value: "99" },
        { key: "--target_headers", value: "wrong_header" },
      ];
      for (const changed of mutations) {
        const send = vi.fn(async (command: any) => {
          const current = Number(command.input.JobName.split("_").at(-1));
          const index = (mapping.jobs as readonly number[]).indexOf(current);
          const fixture = nativeJobFixture(current);
          return {
            Job: {
              Command: fixture.command,
              DefaultArguments: {
                ...fixture.arguments,
                "--folder_location": "test/prepaid_reclass/",
                "--input_file_name": mapping.inputPattern,
                "--target_table": `sdbtdir1_prepaid_dbo.${mapping.targets[index]}`,
              },
              // Glue's non-overridable args take precedence over its defaults.
              NonOverridableArguments:
                current === number ? { [changed.key]: changed.value } : {},
            },
          };
        });
        await expect(
          new AwsSourceJobInspector({ send } as any, {} as any).verify(
            workflow,
            "isg-esatp-dv",
            "test",
          ),
          `${number}: ${changed.key}`,
        ).rejects.toThrow("differs");
        expect(
          send.mock.calls.every(
            ([c]) => c.constructor.name === "GetJobCommand",
          ),
        ).toBe(true);
      }
    },
  );
  it.each(cases)(
    "rejects replacing extractor $number script",
    async ({ workflow, number }) => {
      const mapping = sourceWorkflows[workflow];
      const send = vi.fn(async (command: any) => {
        const current = Number(command.input.JobName.split("_").at(-1));
        const index = (mapping.jobs as readonly number[]).indexOf(current);
        const fixture = nativeJobFixture(current);
        return {
          Job: {
            Command: {
              ...fixture.command,
              ...(current === number
                ? { ScriptLocation: "s3://unverified/other.py" }
                : {}),
            },
            DefaultArguments: {
              ...fixture.arguments,
              "--folder_location": "test/prepaid_reclass/",
              "--input_file_name": mapping.inputPattern,
              "--target_table": `sdbtdir1_prepaid_dbo.${mapping.targets[index]}`,
            },
          },
        };
      });
      await expect(
        new AwsSourceJobInspector({ send } as any, {} as any).verify(
          workflow,
          "isg-esatp-dv",
          "test",
        ),
      ).rejects.toThrow("differs");
    },
  );
  it.each(Object.keys(sourceWorkflows) as SourceWorkflow[])(
    "checks input filenames, bucket and raw target mapping: %s",
    async (workflow) => {
      const mapping = sourceWorkflows[workflow];
      const send = vi.fn(async (c: any) => {
        const index = mapping.jobs.findIndex((number) =>
          c.input.JobName.endsWith(`_${number}`),
        );
        return {
          Job: {
            Command: nativeJobFixture(mapping.jobs[index]!).command,
            DefaultArguments: {
              ...nativeJobColumnArguments(workflow, index),
              "--input_file_name": mapping.inputPattern,
              "--folder_location": "test/prepaid_reclass/",
              "--target_table": `sdbtdir1_prepaid_dbo.${mapping.targets[index]}`,
            },
          },
        };
      });
      await new AwsSourceJobInspector({ send } as any, {} as any).verify(
        workflow,
        "isg-esatp-dv",
        "test",
      );
      expect(
        send.mock.calls.every(([c]) => c.constructor.name === "GetJobCommand"),
      ).toBe(true);
    },
  );
  it("rejects job argument drift without changing it", async () => {
    const send = vi.fn(async () => ({
      Job: {
        Command: { Name: "glueetl" },
        DefaultArguments: { "--folder_location": "wrong/prepaid_reclass/" },
      },
    }));
    await expect(
      new AwsSourceJobInspector({ send } as any, {} as any).verify(
        "load_api_eg",
        "isg-esatp-dv",
        "test",
      ),
    ).rejects.toThrow("differs");
  });
  it.each([
    { "--skip_header_lines": "2" },
    {
      "--valid_columns":
        "count,business,CUSTOMER NAME,date,Doc#,SO#,BillDoc#,description,GROSS AMOUNT",
    },
    { "--valid_columns": "" },
  ])(
    "rejects native skip/ordinal drift before any dispatch: %j",
    async (changed) => {
      const send = vi.fn(async () => ({
        Job: {
          Command: nativeJobFixture(6).command,
          DefaultArguments: {
            ...nativeJobColumnArguments("callcard_eg"),
            "--input_file_name": "CALLCARD_EG.xlsx",
            "--folder_location": "test/prepaid_reclass/",
            "--target_table": "sdbtdir1_prepaid_dbo.dcmanualcallcard",
            ...changed,
          },
        },
      }));
      await expect(
        new AwsSourceJobInspector({ send } as any, {} as any).verify(
          "callcard_eg",
          "isg-esatp-dv",
          "test",
        ),
      ).rejects.toThrow("differs");
      expect(
        send.mock.calls.every(
          ([call]) => call.constructor.name === "GetJobCommand",
        ),
      ).toBe(true);
    },
  );
  it("rejects foreign running workflows", async () => {
    const sfn = {
      send: vi.fn(async () => ({ executions: [{ executionArn: "foreign" }] })),
    };
    await expect(
      new AwsSourceJobInspector({} as any, sfn as any).idle(
        ["machine"],
        "isg-esatp-dv",
        "owned",
      ),
    ).rejects.toThrow("Another source workflow");
  });
  it("waits for active Glue cancellation after a workflow stops", async () => {
    const glue = {
      send: vi.fn(async () => ({ JobRuns: [{ JobRunState: "STOPPING" }] })),
    };
    const sfn = { send: vi.fn(async () => ({ executions: [] })) };
    await expect(
      new AwsSourceJobInspector(glue as any, sfn as any).idle(
        ["machine"],
        "isg-esatp-dv",
        "owned",
      ),
    ).rejects.toThrow("still active");
  });
  it("allows idle jobs and uses only read operations", async () => {
    const glue = {
      send: vi.fn(async () => ({ JobRuns: [{ JobRunState: "SUCCEEDED" }] })),
    };
    const sfn = { send: vi.fn(async () => ({ executions: [] })) };
    await new AwsSourceJobInspector(glue as any, sfn as any).idle(
      ["machine"],
      "isg-esatp-dv",
    );
    expect(glue.send).toHaveBeenCalledTimes(12);
  });
});
