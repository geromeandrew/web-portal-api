import { zipSync } from "fflate";
import { AppError } from "../../../errors.js";
import {
  encodeDelimited,
  jvHeaders,
  manualIntegrationSchema,
} from "../domain/contracts.js";
import { PrepaidRunService } from "./runService.js";
import {
  reportWorkbook,
  type ReportSheet,
} from "../infrastructure/reportWorkbook.js";

/** Exports only immutable, owned revisions; never creates SAP delivery work. */
export async function frozenReports(
  runs: PrepaidRunService,
  userId: string,
  runId: string,
  snapshotId: string,
) {
  return runs.repo.transaction(async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const run = await runs.repo.own(db, userId, runId);
    const revisions = (
      await db.query(
        `SELECT r.*,f.format FROM ${runs.repo.table("region_revisions")} r LEFT JOIN ${runs.repo.table("frozen_report_formats")} f ON f.revision_id=r.id WHERE r.run_id=$1 AND r.source_snapshot_id=$2 AND r.status IN ('frozen','superseded') ORDER BY region,revision`,
        [runId, snapshotId],
      )
    ).rows;
    if (!revisions.length)
      throw new AppError(
        404,
        "PREPAID_REPORT_NOT_FOUND",
        "No frozen reports exist in this source snapshot.",
      );
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    const add = (name: string, bytes: Buffer) => {
      total += bytes.length;
      if (total > 64 * 1024 * 1024)
        throw new AppError(
          413,
          "PREPAID_REPORT_TOO_LARGE",
          "This report archive exceeds the synchronous download limit.",
        );
      files[name] = bytes;
    };
    for (const revision of revisions) {
      const prefix = `${revision.region}-r${revision.revision}`;
      // Never retrofit the new format onto historical frozen revisions.
      const format =
        revision.format ??
        manualIntegrationSchema.parse(run.configuration).format;
      const sheets: ReportSheet[] = [];
      for (const [table, order] of [
        ["layout_rows", "layout_number"],
        ["allocations", "id"],
        ["reconciliation_rows", "revenue_type,allocation_type,tax_rate"],
      ]) {
        const rows = (
          await db.query(
            `SELECT * FROM ${runs.repo.table(table)} WHERE revision_id=$1 ORDER BY ${order} LIMIT 50001`,
            [revision.id],
          )
        ).rows;
        if (rows.length > 50000)
          throw new AppError(
            413,
            "PREPAID_REPORT_TOO_LARGE",
            "This report exceeds the synchronous row limit.",
          );
        const fields = Object.keys(rows[0] ?? {}).filter(
          (x) => x !== "revision_id" && x !== "id",
        );
        if (format.fileType === "xlsx")
          sheets.push({
            name:
              table === "layout_rows"
                ? "Layout"
                : table === "allocations"
                  ? "Allocation"
                  : "Reconciliation",
            headers: fields,
            rows,
          });
        else
          add(
            `${prefix}-${table}.csv`,
            encodeDelimited(rows, fields, ",", "\r\n", "utf8"),
          );
      }
      const jv = (
        await db.query(
          `SELECT fields FROM ${runs.repo.table("jv_lines")} WHERE revision_id=$1 ORDER BY id LIMIT 50001`,
          [revision.id],
        )
      ).rows;
      if (jv.length > 50000)
        throw new AppError(
          413,
          "PREPAID_REPORT_TOO_LARGE",
          "This JV exceeds the synchronous row limit.",
        );
      if (format.fileType === "xlsx") {
        sheets.push({
          name: "JV",
          headers: jvHeaders,
          rows: jv.map((x) => x.fields),
        });
        add(`${prefix}-reports.xlsx`, await reportWorkbook(sheets));
      } else
        add(
          `${prefix}-jv.txt`,
          encodeDelimited(
            jv.map((x) => x.fields),
            jvHeaders,
            format.delimiter,
            format.lineEnding,
            format.encoding,
          ),
        );
    }
    // ZIP defaults to today's timestamp, which changes otherwise immutable bytes.
    return Buffer.from(
      zipSync(files, { level: 0, mtime: new Date(1980, 0, 1) }),
    );
  });
}
