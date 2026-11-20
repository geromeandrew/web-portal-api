import { AppError } from "../../../errors.js";
import { type Region } from "../domain/contracts.js";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { PrepaidStorage } from "../infrastructure/prepaidStorage.js";

/** Ownership-scoped review queries and frozen report downloads. No mutations. */
export class PrepaidReviewService {
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
  ) {}
  private t = (name: string) => this.repo.table(name);
  async output(
    userId: string,
    runId: string,
    region: Region,
    kind: "allocations" | "reconciliation_rows" | "jv_lines",
    variant?: string,
    limit = 100,
    offset = 0,
    revisionId?: string,
  ) {
    const filter = variant ? "AND a.variant=$7" : "";
    const order =
      kind === "reconciliation_rows"
        ? "a.revenue_type,a.allocation_type,a.tax_rate"
        : "a.id";
    // One round trip for ownership, revision and the page. Return real typed
    // columns rather than JSON aggregates, preserving exact numeric strings.
    // A sentinel row retains the revision/count when a page is empty.
    const result = await this.repo.pool.query(
      `WITH owned AS MATERIALIZED (
        SELECT r.id FROM ${this.t("runs")} r JOIN ${this.repo.schema}.workspaces w ON w.id=r.workspace_id
        WHERE r.id=$2 AND w.user_id=$1
      ), selected AS MATERIALIZED (
        SELECT v.id,v.status FROM ${this.t("region_revisions")} v JOIN owned o ON o.id=v.run_id
        WHERE v.region=$3 AND ($4::uuid IS NULL OR v.id=$4)
        ORDER BY v.revision DESC LIMIT 1
      )
      SELECT EXISTS(SELECT 1 FROM owned) __owned,v.id __revision_id,v.status __revision_status,
        CASE WHEN entries.revision_id IS NULL THEN (
          SELECT count(*) FROM ${this.t(kind)} a WHERE a.revision_id=v.id ${filter}
        ) ELSE entries.total_count END __total,entries.*
      FROM (SELECT 1) seed LEFT JOIN selected v ON true
      LEFT JOIN LATERAL (
        SELECT a.*,count(*) OVER() total_count FROM ${this.t(kind)} a
        WHERE a.revision_id=v.id ${filter} ORDER BY ${order} LIMIT $5 OFFSET $6
      ) entries ON true`,
      [
        userId,
        runId,
        region,
        revisionId ?? null,
        limit,
        offset,
        ...(variant ? [variant] : []),
      ],
    );
    const selected = result.rows[0];
    if (!selected?.__owned)
      throw new AppError(
        404,
        "PREPAID_RUN_NOT_FOUND",
        "Prepaid run not found in your workspace.",
      );
    if (!selected.__revision_id)
      throw new AppError(
        404,
        revisionId ? "PREPAID_REVISION_NOT_FOUND" : "PREPAID_LAYOUT_NOT_FOUND",
        revisionId ? "Revision not found." : "Regional layout not found.",
      );
    const rows = result.rows
      .filter((row) => row.revision_id !== null)
      .map((row) => {
        const { __owned, __revision_id, __revision_status, __total, ...data } =
          row;
        return data;
      });
    return {
      revisionId: selected.__revision_id,
      status: selected.__revision_status,
      rows,
      limit,
      offset,
      total: Number(selected.__total),
    };
  }
  async referenceMembership(
    userId: string,
    runId: string,
    region: Region,
    mode: "all" | "gp-non-bb",
    limit = 100,
    offset = 0,
    revisionId?: string,
  ) {
    const selected = await this.output(
      userId,
      runId,
      region,
      "allocations",
      undefined,
      1,
      0,
      revisionId,
    );
    const revision = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("region_revisions")} WHERE id=$1`,
        [selected.revisionId],
      )
    ).rows[0];
    const evidence = (
      await this.repo.pool.query(
        `SELECT count(*)::int total,count(*) FILTER(WHERE nullif(trim(data->>'source_brand'),'') IS NULL)::int unknown FROM ${this.t("stage_reference")} WHERE snapshot_id=$1`,
        [revision.source_snapshot_id],
      )
    ).rows[0];
    if (!evidence.total || evidence.unknown)
      return {
        revisionId: selected.revisionId,
        mode,
        complete: false,
        reason: "REFERENCE_MEMBERSHIP_SOURCE_BRAND_UNVERIFIED",
        unknownRows: evidence.unknown,
        total: 0,
        rows: [] as Record<string, unknown>[],
        limit,
        offset,
      };
    const table = mode === "all" ? "membership_report" : "membership_report_v2";
    const rows = (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t(table)} WHERE revision_id=$1 ORDER BY revenue_type,sub_product,cost_element ${mode === "all" ? ",id" : ""} LIMIT $2 OFFSET $3`,
        [selected.revisionId, limit, offset],
      )
    ).rows;
    const total = Number(
      (
        await this.repo.pool.query(
          `SELECT count(*) n FROM ${this.t(table)} WHERE revision_id=$1`,
          [selected.revisionId],
        )
      ).rows[0].n,
    );
    return {
      revisionId: selected.revisionId,
      mode,
      complete: true,
      reason: null,
      unknownRows: 0,
      total,
      rows,
      limit,
      offset,
    };
  }
  async allocationSummary(
    userId: string,
    runId: string,
    region: Region,
    variant: "mt" | "bb",
    revisionId?: string,
  ) {
    const output = await this.output(
      userId,
      runId,
      region,
      "reconciliation_rows",
      undefined,
      1,
      0,
      revisionId,
    );
    const rows = await this.repo.pool.query(
      `
      WITH detail AS (
        SELECT revenue_type,allocation_type,tax_rate,gross,amount,tax_amount,total_gross,difference,
          CASE WHEN allocation_type='' THEN revenue_type ELSE allocation_type END label
        FROM ${this.t("reconciliation_rows")} r WHERE revision_id=$1
        AND EXISTS(SELECT 1 FROM ${this.t("allocations")} a WHERE a.revision_id=r.revision_id AND a.revenue_type=r.revenue_type AND a.allocation_type=r.allocation_type AND a.tax_rate=r.tax_rate AND a.variant=$2)
      ), combined AS (
        SELECT replace(label,'_',' ') AS type, CASE WHEN row_number() OVER(PARTITION BY label ORDER BY tax_rate)=1 THEN gross END AS gross, tax_rate*100 AS tax_rate, amount, tax_amount AS vat_oct,total_gross,NULL::numeric AS difference, label AS sort_label,0 AS sort_kind FROM detail
        UNION ALL
        SELECT replace(label,'_',' ')||' Difference',max(gross),0,NULL,NULL,sum(total_gross),max(gross)-sum(total_gross),label,1 FROM detail GROUP BY label
        UNION ALL
        SELECT 'Posting Key '||posting_key,NULL,0,sum(abs(round(amount2,2))),NULL,NULL,NULL,'ZZ'||posting_key,2
        FROM ${this.t("allocations")} WHERE revision_id=$1 AND variant=$2 AND abs(round(amount2,2))>=0.01 GROUP BY posting_key
      ) SELECT type,gross,tax_rate,amount,vat_oct,total_gross,difference FROM combined ORDER BY sort_label,sort_kind,tax_rate`,
      [output.revisionId, variant],
    );
    return { revisionId: output.revisionId, rows: rows.rows };
  }
  async reportHistory(
    userId: string,
    date: string | undefined,
    limit: number,
    offset: number,
    includeBatches = false,
  ) {
    const result = await this.repo.pool.query(
      `
      WITH grouped AS (
        SELECT r.id AS run_id,r.period,s.id AS snapshot_id,
          COALESCE((SELECT max((f->>'created_at')::timestamptz) FROM jsonb_array_elements(s.source_files) f),s.created_at) AS uploaded_at,
          COALESCE(NULLIF(u.display_name,''),u.email) AS uploaded_by,
          jsonb_agg(jsonb_build_object('id',v.id,'region',v.region,'revision',v.revision,'frozen_at',v.frozen_at,
            'exports',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind)) FROM ${this.t("exports")} e WHERE e.revision_id=v.id),'[]'::jsonb)) ORDER BY v.region,v.revision) AS revisions, NULL::jsonb AS journals
        FROM ${this.t("runs")} r JOIN ${this.repo.schema}.workspaces w ON w.id=r.workspace_id
        JOIN ${this.t("region_revisions")} v ON v.run_id=r.id AND v.status IN ('frozen','superseded')
        JOIN ${this.t("source_snapshots")} s ON s.id=v.source_snapshot_id
        JOIN ${this.repo.schema}.app_user u ON u.id=w.user_id
        WHERE w.user_id=$1 GROUP BY r.id,s.id,u.display_name,u.email
        ${includeBatches ? `
        UNION ALL
        SELECT NULL::uuid AS run_id, NULL AS period, b.id AS snapshot_id,
          COALESCE((SELECT max(f.created_at) FROM ${this.t("session_files")} f
                    WHERE f.session_id=b.session_id
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.files) item WHERE item->>'key'=f.object_key)),
                   b.created_at) AS uploaded_at,
          COALESCE(NULLIF(u.display_name,''),u.email) AS uploaded_by, '[]'::jsonb AS revisions,
          delivered.journals
        FROM ${this.t("full_batches")} b
        JOIN ${this.t("upload_sessions")} s ON s.id=b.session_id
        JOIN ${this.repo.schema}.workspaces w ON w.id=s.workspace_id
        JOIN ${this.repo.schema}.app_user u ON u.id=w.user_id
        CROSS JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('region', side.key,
              'filename', replace(side.value->'journal'->>'filename', '.txt', '.xlsx')) ORDER BY side.key) AS journals
          FROM jsonb_each(b.executions) side
          WHERE side.key IN ('eg','sg') AND side.value->>'status'='SUCCEEDED'
            AND side.value->'journal'->>'filename' IS NOT NULL
        ) delivered
        WHERE w.user_id=$1 AND delivered.journals IS NOT NULL` : ""}
      ) SELECT *,count(*) OVER() AS total_count FROM grouped
        WHERE ($2::date IS NULL OR (uploaded_at AT TIME ZONE 'Asia/Singapore')::date=$2::date)
        ORDER BY uploaded_at DESC,snapshot_id LIMIT $3 OFFSET $4`,
      [userId, date ?? null, limit, offset],
    );
    return {
      rows: result.rows,
      limit,
      offset,
      hasMore: result.rows.length === limit,
    };
  }
  async history(userId: string, runId: string) {
    await this.repo.own(this.repo.pool, userId, runId);
    return (
      await this.repo.pool.query(
        `SELECT * FROM ${this.t("events")} WHERE run_id=$1 ORDER BY id DESC LIMIT 1000`,
        [runId],
      )
    ).rows;
  }
  async exports(userId: string, runId: string) {
    await this.repo.own(this.repo.pool, userId, runId);
    return (
      await this.repo.pool.query(
        `SELECT e.* FROM ${this.t("exports")} e JOIN ${this.t("region_revisions")} r ON r.id=e.revision_id WHERE r.run_id=$1 ORDER BY e.created_at DESC`,
        [runId],
      )
    ).rows;
  }
  async download(userId: string, runId: string, exportId: string) {
    const record = (await this.exports(userId, runId)).find(
      (x) => x.id === exportId,
    );
    if (!record)
      throw new AppError(
        404,
        "PREPAID_EXPORT_NOT_FOUND",
        "Export not found in this run.",
      );
    return this.storage.get(record.object_key, this.storage.prefix(runId));
  }
}
