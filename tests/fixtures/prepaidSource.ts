import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { vi } from "vitest";
import {
  sourceWorkflows,
  type SourceWorkflow,
} from "../../src/modules/prepaid/domain/sourceExtraction.js";

export function legacyDefinition(workflow: SourceWorkflow) {
  const numbers = [...sourceWorkflows[workflow].jobs];
  return {
    StartAt: `Extract_${numbers[0]}`,
    States: Object.fromEntries(
      numbers.map((number, i) => [
        `Extract_${number}`,
        {
          Type: "Task",
          Resource: "arn:aws:states:::glue:startJobRun.sync",
          Parameters: {
            "JobName.$": `States.Format('{}-prep_reclass-gljo-extract_${number}', $.env_prefix)`,
            Arguments:
              number === 5
                ? {
                    "--previous_job_run_id.$": "$.extract_4_output.Id",
                    "--previous_job_state.$": "$.extract_4_output.JobRunState",
                  }
                : {},
          },
          ...(i === numbers.length - 1
            ? { End: true }
            : {
                ResultPath: "$.extract_4_output",
                Next: `Extract_${numbers[i + 1]}`,
              }),
        },
      ]),
    ),
  };
}
export function fakeS3() {
  const objects = new Map<
    string,
    { bytes: Buffer; metadata?: Record<string, string>; etag: string }
  >();
  const error = (status: number, name: string) =>
    Object.assign(Error(name), { name, $metadata: { httpStatusCode: status } });
  const set = (
    key: string,
    bytes: Buffer,
    metadata?: Record<string, string>,
  ) => {
    objects.set(key, {
      bytes,
      metadata,
      etag: `"${createHash("sha256").update(bytes).digest("hex")}"`,
    });
  };
  const send = vi.fn(async (command: any) => {
    const { Key, Body, Metadata, IfNoneMatch, IfMatch, Prefix } = command.input;
    const existing = objects.get(Key);
    switch (command.constructor.name) {
      case "GetObjectCommand":
        if (!existing) throw error(404, "NoSuchKey");
        return {
          Body: Object.assign(Readable.from([existing.bytes]), {
            transformToString: async () => existing.bytes.toString(),
            transformToByteArray: async () => existing.bytes,
          }),
          ContentLength: existing.bytes.length,
          Metadata: existing.metadata,
          ETag: existing.etag,
        };
      case "PutObjectCommand":
        if (IfNoneMatch === "*" && existing)
          throw error(412, "PreconditionFailed");
        set(Key, Buffer.from(Body), Metadata);
        return {};
      case "DeleteObjectCommand":
        if (IfMatch && existing?.etag !== IfMatch)
          throw error(412, "PreconditionFailed");
        objects.delete(Key);
        return {};
      case "ListObjectsV2Command":
        return {
          Contents: [...objects.keys()]
            .filter((key) => key.startsWith(Prefix))
            .map((key) => ({ Key: key })),
        };
      default:
        throw Error(`Unexpected S3 command ${command.constructor.name}`);
    }
  });
  return { objects, set, send };
}
