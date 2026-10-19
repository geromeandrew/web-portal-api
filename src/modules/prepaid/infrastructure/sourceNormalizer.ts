import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { SourceWorkflow } from "../domain/sourceExtraction.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";

export interface SourceNormalizer {
  revision(): Promise<string>;
  normalize(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period?: string,
  ): Promise<Record<string, unknown[]>>;
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
      .update(await readFile(this.helper))
      .update(await readFile(this.core))
      .digest("hex");
  }
  async normalize(
    workflow: SourceWorkflow,
    code: string,
    bytes: Buffer,
    period?: string,
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
    return new Promise<Record<string, unknown[]>>((resolve, reject) => {
      const child = spawn(
        executable,
        [
          "-X",
          "utf8",
          fileURLToPath(this.helper),
          workflow,
          code,
          ...(period ? [period] : []),
        ],
        { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const output: Buffer[] = [],
        errors: Buffer[] = [];
      let size = 0,
        settled = false;
      const finish = (error?: Error, value?: Record<string, unknown[]>) => {
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
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.values(value).some((v) => !Array.isArray(v))
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
