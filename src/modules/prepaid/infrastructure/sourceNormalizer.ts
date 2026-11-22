import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type {
  SourceWorkflow,
  EgReportMapping,
} from "../domain/sourceExtraction.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";

export interface SourceNormalizer {
  normalizeRaw?(
    workflow: SourceWorkflow,
    code: string,
    tables: Record<string, Record<string, string | null>[]>,
    period?: string,
  ): Promise<Record<string, unknown[]>>;
  revision(): Promise<string>;
  normalize(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period?: string,
    mapping?: EgReportMapping,
  ): Promise<Record<string, unknown[]>>;
  prepare?(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period?: string,
    mapping?: EgReportMapping,
  ): Promise<{ datasets: Record<string, unknown[]>; landing?: Buffer }>;
}

/** Python is a local parsing helper, not another Step Function/Glue deployment. */
export class BackendSourceNormalizer implements SourceNormalizer {
  private readonly helper = new URL(
    "../../../../infrastructure/prepaid/normalize_source.py",
    import.meta.url,
  );
  private readonly core = new URL(
    "../../../../infrastructure/prepaid/portal_source_extract.py",
    import.meta.url,
  );
  async revision() {
    return createHash("sha256")
      .update(
        await readFile(
          new URL(
            "../../../../infrastructure/prepaid/normalize_raw_source.py",
            import.meta.url,
          ),
        ),
      )
      .update(await readFile(this.helper))
      .update(await readFile(this.core))
      .update(
        await readFile(
          new URL(
            "../../../../infrastructure/prepaid/workbook_stream.py",
            import.meta.url,
          ),
        ),
      )
      .update(
        await readFile(
          new URL(
            "../../../../infrastructure/prepaid/eg_report_adapter.py",
            import.meta.url,
          ),
        ),
      )
      .digest("hex");
  }
  async normalize(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period?: string,
    mapping?: EgReportMapping,
  ) {
    return this.execute(
      workflow,
      code,
      bytes,
      period,
      mapping,
      false,
    ) as Promise<Record<string, unknown[]>>;
  }
  async normalizeRaw(
    workflow: SourceWorkflow,
    code: string,
    tables: Record<string, Record<string, string | null>[]>,
    period?: string,
  ) {
    return this.execute(
      workflow,
      code,
      Buffer.from(JSON.stringify(tables)),
      period,
      undefined,
      false,
      true,
    ) as Promise<Record<string, unknown[]>>;
  }
  async prepare(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period?: string,
    mapping?: EgReportMapping,
    landingOnly = false,
  ) {
    const result = (await this.execute(
      workflow,
      code,
      bytes,
      period,
      mapping,
      true,
      false,
      landingOnly,
    )) as any;
    const landing =
      result.landing === undefined
        ? undefined
        : Buffer.from(result.landing, "base64");
    if (
      landing &&
      (!landing.length || landing.length > prepaidMaximumSourceBytes)
    )
      throw Error("Invalid adapted source size.");
    return {
      datasets: result.datasets as Record<string, unknown[]>,
      ...(landing ? { landing } : {}),
    };
  }
  private async execute(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period: string | undefined,
    mapping: EgReportMapping | undefined,
    prepare: boolean,
    raw = false,
    landingOnly = false,
  ) {
    if (bytes.length > prepaidMaximumSourceBytes)
      throw Error("Source exceeds portal upload limit.");
    const venv = fileURLToPath(
      new URL(
        process.platform === "win32"
          ? "../../../../.venv-prepaid/Scripts/python.exe"
          : "../../../../.venv-prepaid/bin/python",
        import.meta.url,
      ),
    );
    const executable =
      process.env.PREPAID_PYTHON_EXECUTABLE ||
      (existsSync(venv)
        ? venv
        : process.platform === "win32"
          ? "python"
          : "python3");
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          "-X",
          "utf8",
          fileURLToPath(this.helper),
          workflow,
          code,
          period ?? "",
          mapping ? JSON.stringify(mapping) : "",
          ...(raw ? ["raw"] : prepare ? [landingOnly ? "landing" : "prepare"] : []),
        ],
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const output: Buffer[] = [],
        errors: Buffer[] = [];
      let size = 0,
        settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          child.kill();
          reject(error);
        } else resolve(value!);
      };
      const timeout = setTimeout(
        () => finish(Error("Backend source normalization timed out.")),
        180_000,
      );
      child.on("error", () =>
        finish(
          Error(
            "Python source normalizer is unavailable. Install the Prepaid Python requirements or configure PREPAID_PYTHON_EXECUTABLE.",
          ),
        ),
      );
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64_000_000)
          finish(Error("Normalized source exceeds output limit."));
        else output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errors.reduce((n, b) => n + b.length, 0) < 4000) errors.push(chunk);
      });
      child.on("close", (status) => {
        if (status !== 0)
          return finish(
            Error(
              `Source normalization failed: ${Buffer.concat(errors).toString().trim().slice(0, 600) || "invalid source"}`,
            ),
          );
        try {
          const value = JSON.parse(Buffer.concat(output).toString());
          const datasets = prepare ? value?.datasets : value;
          if (
            !datasets ||
            typeof datasets !== "object" ||
            Array.isArray(datasets) ||
            Object.values(datasets).some((v) => !Array.isArray(v)) ||
            (prepare &&
              value.landing !== undefined &&
              (typeof value.landing !== "string" ||
                !/^[A-Za-z0-9+/]+={0,2}$/.test(value.landing)))
          )
            throw Error("Invalid normalized source output.");
          finish(undefined, value);
        } catch {
          finish(Error("Backend normalizer returned invalid JSON datasets."));
        }
      });
      child.stdin.end(bytes);
    });
  }
}
