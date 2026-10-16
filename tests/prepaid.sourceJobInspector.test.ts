import { describe, expect, it, vi } from "vitest";
import { AwsSourceJobInspector } from "../src/modules/prepaid/infrastructure/sourceJobInspector.js";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../src/modules/prepaid/domain/sourceExtraction.js";

describe("Read-only existing Glue job inspection", () => {
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
            Command: { Name: "glueetl" },
            DefaultArguments: {
              "--input_file_name": mapping.inputPattern,
              "--folder_location": "test/prepaid_reclass/",
              "--target_table": `sdbtdir1_prepaid_dbo.${mapping.targets[index]}`,
              "--move_to_success": "false",
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
    expect(glue.send).toHaveBeenCalledTimes(5);
  });
});
