import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { reportWorkbook } from "../infrastructure/reportWorkbook.js";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import type { PrepaidImportStage, StepFunctionsRunner } from "../../../stepFunctionsRunner.js";
import type { Config } from "../../../config.js";
import { AppError } from "../../../errors.js";
import {
  manualIntegrationSchema,
  type editSchema,
  requiredBillingSources,
  sourceCodes,
} from "../domain/contracts.js";
import { prepaidMaximumSourceBytes } from "../domain/limits.js";
import {
  sourceBelongsTo,
  sourceLandingName,
  sourceWorkflows,
  type SourceWorkflow,
} from "../domain/sourceExtraction.js";
import type { PrepaidRepository } from "../infrastructure/repository.js";
import {
  sha256,
  type PrepaidStorage,
} from "../infrastructure/prepaidStorage.js";

const machines = {
  import: "prcl_proc-sf",
  eg: "prcl_egfrz-sf",
  sg: "prcl_sgfrz-sf",
} as const;
type Phase = keyof typeof machines;
type Region = Exclude<Phase, "import">;
type LayoutRow = {
  layout_number: number;
  label: string;
  gross: string | null;
  net: string | null;
  frozen: boolean | null;
};
type File = {
  code: string;
  key: string;
  sha256: string;
  name: string;
  workflow: SourceWorkflow;
};
type Journal = { filename: string; sha256: string; key: string; size: number };
type Execution = {
  arn: string;
  startedAt: string;
  status: string;
  journal?: Journal;
  importStage?: PrepaidImportStage;
};
type Batch = {
  id: string;
  session_id: string;
  files: File[];
  inputs_staged: boolean;
  phase: Phase | "cleanup" | "release";
  status: "queued" | "running" | "review" | "failed" | "closed";
  executions: Partial<Record<Phase, Execution>>;
  layouts: Partial<Record<Region, LayoutRow[]>>;
  error: string | null;
};
const workflows = Object.keys(sourceWorkflows) as SourceWorkflow[];
const schema = "dswtdir1_prepaid_dbo";
const editableRows = {
  eg: [8, 9, 10, 13, 22, 23, 24],
  sg: [8, 9, 12, 13, 14, 22, 23, 24],
};
const grossFields = ["gp_mt_gross", "hy_mt_gross", "gp_bb_gross"] as const;
type LayoutChange = ReturnType<typeof editSchema.parse>["changes"][number];
const maximumJournalBytes = 16 * 1024 * 1024;
const outbound = "prepaid_reclass/outbound/";
const journalFilename = (region: Region) =>
  `txPrepaid_JV_${region.toUpperCase()}Sel.txt`;

export function prepaidFullBatchPrefix(config: Config) {
  if (config.SFN_PREFIX) return config.SFN_PREFIX;

  // Preserve existing sandbox deployments until their prefix is set explicitly.
  const sandbox =
    config.AWS_REGION === "us-east-1" &&
    [
      "database-1.cluster-c0x8ko8cis42.us-east-1.rds.amazonaws.com",
      "database-1-instance-1.c0x8ko8cis42.us-east-1.rds.amazonaws.com",
    ].includes(config.DATABASE_HOST) &&
    config.DATABASE_PORT === 5432 &&
    config.DATABASE_NAME === "postgres" &&
    config.DATABASE_SSL &&
    config.S3_BUCKET === "isg-esatp-rcc-storage-os";
  return sandbox ? "isg-esatp-dv" : undefined;
}

export class PrepaidFullBatch {
  constructor(
    readonly repo: PrepaidRepository,
    readonly storage: PrepaidStorage,
    readonly runner: StepFunctionsRunner,
    readonly envPrefix: NonNullable<Config["SFN_PREFIX"]>,
    readonly deliveryEnabled: boolean,
  ) {}
  private get table() {
    return this.repo.table("full_batches");
  }
  private get landing() {
    return this.storage.legacyLanding();
  }
  private canClose(batch: Batch) {
    return (
      batch.status === "review" ||
      batch.status === "failed" ||
      (batch.phase === "import" && batch.status === "queued" && !batch.inputs_staged)
    );
  }
  private snapshot(batch: Batch | undefined) {
    if (!batch) return null;
    const { id, phase, status, executions, layouts, error } = batch;
    return {
      canClose: this.canClose(batch),
      canReview: batch.status !== "closed" && !["cleanup", "release"].includes(phase)
        && executions.import?.status === "SUCCEEDED" && !!layouts.eg?.length && !!layouts.sg?.length,
      id,
      phase,
      status,
      executions,
      layouts,
      error,
      deliveryEnabled: this.deliveryEnabled,
    };
  }
  private async owned(
    user: string,
    db: Pick<PoolClient, "query"> = this.repo.pool,
    lock = false,
    id?: string,
  ) {
    return (
      await db.query<Batch>(
        `SELECT b.* FROM ${this.table} b
       JOIN ${this.repo.table("upload_sessions")} s ON s.id=b.session_id
       JOIN ${this.repo.schema}.workspaces w ON w.id=s.workspace_id
       WHERE w.user_id=$1 AND ($2::uuid IS NULL OR b.id=$2)
       ORDER BY (b.status <> 'closed') DESC,b.created_at DESC
       LIMIT 1 ${lock ? "FOR UPDATE OF b" : ""}`,
        [user, id ?? null],
      )
    ).rows[0];
  }
  async status(user: string) {
    return this.snapshot(await this.owned(user));
  }
  private async layoutReview(db: PoolClient, batch: Batch, region: Region) {
    const table = region === "eg" ? "dcprepaidsystems" : "dcprepaidsystems_sg";
    const { rows } = await db.query<{ layout_number: number; label: string | null; frozen: boolean }>(
      `SELECT "Layout Number" AS layout_number, "REVENUES BEFORE RECLASS" AS label,
              freezedata AS frozen, gp_${region}_mt_gross AS gp_mt_gross,
              hy_${region}_mt_gross AS hy_mt_gross, gp_${region}_bb_gross AS gp_bb_gross,
              total_gross, gp_${region}_mt_net AS gp_mt_net, hy_${region}_mt_net AS hy_mt_net,
              gp_${region}_bb_net AS gp_bb_net, total_net
       FROM ${schema}.${table} ORDER BY "Layout Number"`,
    );
    const canEdit = batch.status === "review" && !batch.executions[region] && rows.every((row) => !row.frozen);
    const layoutVersion = sha256(Buffer.from(JSON.stringify(rows)));

    return {
      rows: rows.filter((row) => row.layout_number !== 0 || row.label?.trim()).map((row) => ({
        ...row,
        editable_fields: canEdit && editableRows[region].includes(row.layout_number)
          ? grossFields.slice()
          : [],
      })),
      layoutVersion, canEdit, hasMore: false, pendingJournal: false,
    };
  }
  async review(
    user: string,
    id: string,
    region: Region,
    section: "layout" | "allocation" | "allocation-summary" | "jv",
    variant: "mt" | "bb",
    offset: number,
  ) {
    return this.repo.transaction(async (db) => {
      const batch = await this.owned(user, db, true);
      if (!batch || batch.id !== id || !this.snapshot(batch)?.canReview)
        throw new AppError(409, "PREPAID_BATCH_NOT_READY", "Wait for the import to finish before reviewing it.");

      if (section === "jv" && !batch.executions[region]?.journal)
        return { rows: [], hasMore: false, pendingJournal: true };

      await this.landing.assertOwner(batch.id);
      if (!isDeepStrictEqual(await this.layout(db, region), batch.layouts[region]))
        throw new AppError(409, "PREPAID_BATCH_LAYOUT_CHANGED", "The layout changed after import. Refresh after processing finishes.");

      if (section === "layout") return this.layoutReview(db, batch, region);

      const allocationParams = [region.toUpperCase(), variant.toUpperCase()];
      if (section === "allocation-summary") {
        // Use the converted base and split allocations that feed the journal.
        const { rows } = await db.query(
          `WITH lines AS (
             SELECT revenuetype AS label, gross::numeric, "Tax Rate"::numeric AS rate,
                    amount2::numeric AS amount, CASE WHEN amount2 < 0 THEN 40 ELSE postingkey END AS posting
             FROM ${schema}.webprepaidsystems_formatc133
             WHERE revenuetype2=$1 AND right(revenuetype, 2)=$2
             UNION ALL
             SELECT allocationtype, NULL, "Tax Rate"::numeric, sum(amount2::numeric),
                    CASE WHEN sum(amount2) < 0 THEN 50 ELSE 40 END
             FROM ${schema}.webprepaidsystems_formatc145
             WHERE revenuetype2=$1 AND right(revenuetype, 2)=$2
             GROUP BY "Period/year","Profit Center","Cost Element","Sub-Product Group B",
                      "Unit of Measure","Tax Rate","Ave Rate",allocationtype
           ), detail AS (
             SELECT label, rate, max(gross) AS gross, sum(amount) AS amount,
                    sum(amount)*rate AS vat, sum(amount)*(1+rate) AS total
             FROM lines GROUP BY label,rate
           ), combined AS (
             SELECT replace(label,'_',' ') AS type,
                    CASE WHEN row_number() OVER(PARTITION BY label ORDER BY rate)=1 THEN gross END AS gross,
                    rate*100 AS tax_rate, amount, vat AS vat_oct, total AS total_gross,
                    NULL::numeric AS difference, label AS sort_label, 0 AS sort_kind
             FROM detail
             UNION ALL
             SELECT replace(label,'_',' ')||' Difference',max(gross),0,NULL,NULL,sum(total),
                    max(gross)-sum(total),label,1
             FROM detail GROUP BY label
             UNION ALL
             SELECT 'Posting Key '||posting,NULL,0,sum(abs(round(amount,2))),NULL,NULL,NULL,'ZZ'||posting,2
             FROM lines WHERE abs(round(amount,2))>=0.01 GROUP BY posting
           )
           SELECT type,gross,tax_rate,amount,vat_oct,total_gross,difference
           FROM combined ORDER BY sort_label,sort_kind,tax_rate`,
          allocationParams,
        );
        return { rows, hasMore: false, pendingJournal: false };
      }

      const sql = section === "allocation"
        ? `WITH breakdown AS (
             SELECT "Profit Center" AS profit_center, "Cost Element" AS cost_element,
                    "Sub-Product Group B" AS sub_product, revenuetype AS revenue_type,
                    '' AS allocation_type, "Tax Rate" AS tax_rate, "Ave Rate" AS average_rate,
                    "Unit of Measure" AS uom, amount, amount_sum_revenuetype AS denominator,
                    allocation, gross, CASE WHEN amount2 < 0 THEN 40 ELSE postingkey END AS posting_key,
                    amount2, hits2
             FROM ${schema}.webprepaidsystems_formatc133
             WHERE revenuetype2=$1 AND right(revenuetype, 2)=$2
             UNION ALL
             SELECT "Profit Center", "Cost Element", "Sub-Product Group B", revenuetype,
                    allocationtype, "Tax Rate", "Ave Rate", "Unit of Measure", amount,
                    amount_sum_revenuetype, allocation, gross,
                    CASE WHEN amount2 < 0 THEN 50 ELSE postingkey END, amount2, hits2
             FROM ${schema}.webprepaidsystems_formatc145
             WHERE revenuetype2=$1 AND right(revenuetype, 2)=$2
           )
           SELECT * FROM breakdown
           ORDER BY revenue_type, allocation_type, profit_center, cost_element, sub_product,
                    uom, tax_rate, average_rate, amount, denominator, allocation, gross,
                    posting_key, amount2, hits2
           OFFSET $3 LIMIT 101`
        : `SELECT * FROM ${schema}.txprepaid_jv_${region}sel
           ORDER BY "Posting Key", "Account or Matchcode for theNext Line Item", "Profit center", "Amount in local currency", "Text", "Quantity", "sub-product -B"
           OFFSET $1 LIMIT 101`;
      const params = section === "allocation" ? [...allocationParams, offset] : [offset];
      const { rows } = await db.query(sql, params);
      return { rows: rows.slice(0, 100), hasMore: rows.length > 100, pendingJournal: false };
    });
  }
  async saveLayout(
    user: string,
    id: string,
    region: Region,
    layoutVersion: string,
    changes: LayoutChange[],
  ) {
    return this.repo.transaction(async (db) => {
      const batch = await this.owned(user, db, true);
      if (!batch || batch.id !== id || !this.snapshot(batch)?.canReview || batch.status !== "review")
        throw new AppError(409, "PREPAID_BATCH_NOT_READY", "Wait for processing to finish before editing.");
      await this.landing.assertOwner(batch.id);
      const table = region === "eg" ? "dcprepaidsystems" : "dcprepaidsystems_sg";
      await db.query(`LOCK TABLE ${schema}.${table} IN SHARE ROW EXCLUSIVE MODE`);
      const current = await this.layoutReview(db, batch, region);
      if (!current.canEdit)
        throw new AppError(409, "PREPAID_BATCH_LAYOUT_LOCKED", "This layout is locked.");
      if (current.layoutVersion !== layoutVersion ||
          !isDeepStrictEqual(await this.layout(db, region), batch.layouts[region]))
        throw new AppError(409, "PREPAID_STALE_VERSION", "The layout has changed. Reload it before saving.");

      const save = (row: number, field: LayoutChange["field"], value: string | null) => db.query(
        `CALL ${schema}.sp_prepaid1_${region}layout_save_pgx($1,$2,$3)`,
        [row, field.replace("_mt_", `_${region}_mt_`).replace("_bb_", `_${region}_bb_`), value],
      );
      for (const { layoutNumber, field, value } of changes) {
        const row = current.rows.find((item) => item.layout_number === layoutNumber);
        if (!row?.editable_fields.includes(field))
          throw new AppError(400, "PREPAID_LAYOUT_CELL_READ_ONLY", "Only editable gross cells can be saved.");
        await save(layoutNumber, field, value);
      }

      // The existing calculation writes the variance before updating its additional-revenue row.
      // Repeating it brings the variance in line with the edited totals without overwriting manual reclass cells.
      await db.query(`CALL ${schema}.sp_prepaid1_${region}layout_compute_topup_pgx()`);
      await db.query(`CALL ${schema}.sp_prepaid1_${region}layout_compute_topup_pgx()`);
      batch.layouts[region] = await this.layout(db, region);
      await db.query(`UPDATE ${this.table} SET layouts=$2 WHERE id=$1`, [batch.id, JSON.stringify(batch.layouts)]);
      return this.layoutReview(db, batch, region);
    });
  }
  async download(user: string, region: Region, batchId?: string) {
    const batch = await this.owned(user, this.repo.pool, false, batchId);
    const journal = batch?.executions[region]?.journal;
    if (!batch || !journal)
      throw new AppError(
        404,
        "PREPAID_BATCH_JOURNAL_MISSING",
        "The journal has not been verified for this batch.",
      );
    const bytes = await this.storage.bytes(
      journal.key,
      this.storage.sessionPrefix(batch.session_id),
      maximumJournalBytes,
    );
    if (sha256(bytes) !== journal.sha256 || bytes.length !== journal.size)
      throw Error(
        "The archived journal checksum differs from the verified export.",
      );
    return { filename: journal.filename, content: bytes.toString("base64") };
  }
  async downloadWorkbook(user: string, batchId: string, region: Region) {
    const journal = await this.download(user, region, batchId);
    const workbook = new ExcelJS.Workbook();
    const worksheet = await workbook.csv.read(
      Readable.from([Buffer.from(journal.content, "base64")]),
      { parserOptions: { delimiter: "\t", ignoreEmpty: true }, map: (value) => value },
    );
    const headers = (worksheet.getRow(1).values as string[]).slice(1);
    if (!headers.length || new Set(headers).size !== headers.length)
      throw new AppError(422, "PREPAID_JOURNAL_FORMAT_INVALID", "The journal has invalid column headers.");
    const rows: Record<string, unknown>[] = [];
    worksheet.eachRow((row, index) => {
      if (index === 1) return;
      if (row.cellCount > headers.length)
        throw new AppError(422, "PREPAID_JOURNAL_FORMAT_INVALID", "The journal contains an invalid row.");
      rows.push(Object.fromEntries(headers.map((header, column) => [header, row.getCell(column + 1).value])));
    });
    return {
      filename: journal.filename.replace(/\.txt$/i, ".xlsx"),
      bytes: await reportWorkbook([{ name: "JV", headers, rows }]),
    };
  }
  private async archive(batch: Batch, region: Region, startedAt: string, completedAt: string | null) {
    const filename = journalFilename(region);
    const delivered = outbound + "sftp-pushed/";
    const key = await this.storage.deliveredJournalKey(delivered, filename, startedAt, completedAt);
    const object = await this.storage.get(key, delivered);
    if (
      !object.Body ||
      !object.LastModified ||
      object.LastModified.getTime() < Date.parse(startedAt) ||
      !object.ContentLength ||
      object.ContentLength > maximumJournalBytes
    ) {
      (object.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw Error("Expected a fresh journal from this AWS freeze execution.");
    }
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    if (bytes.length !== object.ContentLength)
      throw Error("AWS journal download is incomplete.");
    const prefix = this.storage.sessionPrefix(batch.session_id);
    const saved = await this.storage.putVerified(
      `${prefix}aws-batch/${batch.id}/${filename}`,
      prefix,
      bytes,
      "text/plain",
    );
    return { ...saved, filename };
  }
  private async layout(db: PoolClient, region: Region) {
    const table = region === "eg" ? "dcprepaidsystems" : "dcprepaidsystems_sg";
    return (
      await db.query<LayoutRow>(
        `SELECT "Layout Number" layout_number,"REVENUES BEFORE RECLASS" label,
       total_gross::text gross,total_net::text net,freezedata frozen
       FROM ${schema}.${table} ORDER BY "Layout Number"`,
      )
    ).rows;
  }
  /** The workspace holds the upload-session lock while binding its completed files. */
  async enqueueSession(
    db: PoolClient,
    session: { id: string; configuration: unknown },
  ): Promise<boolean> {
    const active = await db.query(
      `SELECT 1 FROM ${this.table} WHERE session_id=$1 AND status <> 'closed'`,
      [session.id],
    );
    if (active.rowCount) return false;
    const configuration = manualIntegrationSchema.safeParse(
      session.configuration,
    );
    if (!configuration.success)
      throw new AppError(
        409,
        "PREPAID_BATCH_CONFIG_REQUIRED",
        "Configure the approved Prepaid billing cycles before importing reports.",
      );
    const rows = (
      await db.query(
        `SELECT source_code,object_key,sha256 FROM ${this.repo.table("session_files")} WHERE session_id=$1 AND active ORDER BY source_code`,
        [session.id],
      )
    ).rows;
    const required = [
      ...sourceCodes,
      ...requiredBillingSources(configuration.data),
    ];
    const files = rows.map((file): File => {
      const workflow = workflows.find((item) =>
        sourceBelongsTo(item, file.source_code),
      );
      if (!workflow)
        throw new AppError(
          409,
          "PREPAID_BATCH_UNEXPECTED_SOURCE",
          "Remove files outside the configured billing cycles.",
        );
      return {
        code: file.source_code,
        key: file.object_key,
        sha256: file.sha256,
        workflow,
        name: sourceLandingName(workflow, file.source_code),
      };
    });
    if (
      files.length !== required.length ||
      required.some((code) => !files.some((f) => f.code === code))
    )
      throw new AppError(
        409,
        "PREPAID_BATCH_INPUT_REQUIRED",
        "Upload every source and billing cycle configured for this batch.",
      );
    const prior = await db.query(
      `SELECT 1 FROM ${this.table} WHERE session_id=$1 AND files @> $2::jsonb AND files <@ $2::jsonb LIMIT 1`,
      [session.id, JSON.stringify(files)],
    );
    if (prior.rowCount) return false;
    for (const region of ["eg", "sg"] as const) {
      if (
        !(await this.layout(db, region)).some((row) => row.label === "Variance")
      )
        throw new AppError(
          409,
          "PREPAID_BATCH_LAYOUT_REQUIRED",
          "The EG and SG layouts are unavailable. Contact support.",
        );
    }
    const inserted = (
      await db.query<Batch>(
        `INSERT INTO ${this.table}(id,session_id,files,phase,status)
         VALUES($1,$2,$3,'import','queued') ON CONFLICT DO NOTHING RETURNING *`,
        [randomUUID(), session.id, JSON.stringify(files)],
      )
    ).rows[0];
    if (!inserted)
      throw new AppError(
        409,
        "PREPAID_BATCH_BUSY",
        "Another import is active. Your files will be processed when it finishes.",
      );
    return true;
  }
  async closeForReset(db: PoolClient, sessionId: string) {
    const batch = (
      await db.query<Batch>(
        `SELECT * FROM ${this.table} WHERE session_id=$1 AND status<>'closed' FOR UPDATE`,
        [sessionId],
      )
    ).rows[0];
    if (!batch || batch.phase === "cleanup" || batch.phase === "release") return;
    if (!this.canClose(batch))
      throw new AppError(409, "PREPAID_BATCH_NOT_READY", "Wait for processing to finish before resetting.");
    await this.queuePhase(db, batch.id, "cleanup");
  }
  private async queuePhase(db: PoolClient, id: string, phase: Batch["phase"]) {
    await db.query(
      `UPDATE ${this.table} SET phase=$2,status='queued',error=NULL,next_check=now() WHERE id=$1`,
      [id, phase],
    );
  }
  async action(user: string, action: Region | "close") {
    return this.repo.transaction(async (db) => {
      const batch = await this.owned(user, db, true);
      if (!batch || !(action === "close" ? this.canClose(batch) : ["review", "failed"].includes(batch.status)))
        throw new AppError(
          409,
          "PREPAID_BATCH_NOT_READY",
          "Wait for processing to finish.",
        );
      if (action !== "close") {
        if (!this.deliveryEnabled)
          throw new AppError(
            409,
            "PREPAID_BATCH_DELIVERY_DISABLED",
            "Freeze and delivery are currently unavailable.",
          );
        const variance = batch.layouts[action]?.find(
          (row) => row.label === "Variance",
        )?.gross;
        if (
          batch.status !== "review" ||
          batch.executions.import?.status !== "SUCCEEDED" ||
          batch.executions[action] ||
          !variance ||
          !/^[+-]?0+(\.0+)?$/.test(variance.trim())
        )
          throw new AppError(
            409,
            "PREPAID_BATCH_FREEZE_NOT_READY",
            "This side needs a successful import, zero variance, and no prior freeze attempt.",
          );
      }
      if (action !== "close") {
        await this.landing.assertOwner(batch.id);
        if (
          !isDeepStrictEqual(
            await this.layout(db, action),
            batch.layouts[action],
          )
        )
          throw new AppError(
            409,
            "PREPAID_BATCH_LAYOUT_CHANGED",
            "The layout changed after import. Reset and upload the reports again before freezing.",
          );
      }
      await this.queuePhase(db, batch.id, action === "close" ? "cleanup" : action);
      return { queued: true };
    });
  }
  async tick() {
    let claimed: string | undefined;
    try {
      return await this.advance((id) => {
        claimed = id;
      });
    } catch (error) {
      if (claimed)
        await this.repo.pool.query(
          `UPDATE ${this.table} SET error=$2,next_check=now()+interval '15 seconds'
         WHERE id=$1 AND status IN ('queued','running')`,
          [
            claimed,
            "Processing is temporarily delayed and will retry automatically.",
          ],
        );
      throw error;
    }
  }
  private async advance(claim: (id: string) => void) {
    return this.repo.transaction(async (db) => {
      const batch = (
        await db.query<Batch>(
          `SELECT * FROM ${this.table} WHERE status IN ('queued','running')
         AND next_check<=now() LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!batch) return false;
      const { id, phase } = batch;
      claim(id);
      if (phase === "cleanup") {
        for (const workflow of (await this.landing.owns(id)) ? workflows : []) {
          const files = batch.files.filter((f) => f.workflow === workflow);
          await this.landing.finish(id, workflow, files, false);
        }
        await db.query(`UPDATE ${this.table} SET phase='release' WHERE id=$1`, [
          id,
        ]);
        return true;
      }
      if (phase === "release") {
        await this.landing.release(id, true);
        await db.query(`UPDATE ${this.table} SET status='closed' WHERE id=$1`, [
          id,
        ]);
        return true;
      }
      const prior = batch.executions[phase];
      if (!prior) {
        const name = `${this.envPrefix}-${machines[phase]}`;
        const machine = await this.runner.describeStateMachine(name);
        if (
          machine.type !== "STANDARD" ||
          machine.status !== "ACTIVE" ||
          machine.name !== name
        )
          throw Error(
            "Prepaid AWS batch requires an active Standard state machine.",
          );
        if (phase === "import" && !batch.inputs_staged) {
          await this.landing.acquire(id);
          for (const workflow of workflows) {
            const files = [];
            for (const file of batch.files.filter(
              (f) => f.workflow === workflow,
            )) {
              files.push({
                ...file,
                bytes: await this.storage.bytes(
                  file.key,
                  this.storage.sessionPrefix(batch.session_id),
                  prepaidMaximumSourceBytes,
                ),
              });
            }
            await this.landing.stage(id, workflow, files);
          }
          await db.query(
            `UPDATE ${this.table} SET inputs_staged=true,error=NULL WHERE id=$1`,
            [id],
          );
          return true;
        }
        await this.landing.assertOwner(id);
        const started = await this.runner.startExecution(
          name,
          phase === "import"
            ? { env_prefix: this.envPrefix, skip_extract: false }
            : { env_prefix: this.envPrefix },
          `portal-prepaid-${id}-${phase}`,
        );
        batch.executions[phase] = {
          arn: started.executionArn,
          startedAt: started.startedAt,
          status: "RUNNING",
        };
        await db.query(
          `UPDATE ${this.table} SET status='running',error=NULL,executions=$2,next_check=now()+interval '10 seconds' WHERE id=$1`,
          [id, JSON.stringify(batch.executions)],
        );
        return true;
      }
      const result = await this.runner.describeExecution(prior.arn);
      if (result.status === "RUNNING" || result.status === "PENDING_REDRIVE") {
        if (phase === "import" && prior.importStage !== "importing-layouts") {
          // Progress is optional and must not prevent the worker from tracking completion.
          const stage = await this.runner.prepaidImportStage?.(prior.arn).catch(() => undefined);
          if (stage) prior.importStage = stage;
        }
        await db.query(
          `UPDATE ${this.table} SET executions=$2,next_check=now()+interval '10 seconds' WHERE id=$1`,
          [id, JSON.stringify(batch.executions)],
        );
        return true;
      }
      prior.status = result.status;
      let message =
        result.status === "SUCCEEDED"
          ? null
          : "Processing did not complete. Contact support if the issue persists.";
      if (result.status === "SUCCEEDED") {
        await this.landing.assertOwner(id);
        if (phase !== "import") {
          try {
            prior.journal = await this.archive(batch, phase, prior.startedAt, result.completedAt);
          } catch {
            message =
              "The journal could not be verified. Contact support before continuing.";
          }
        }
        if (phase === "import" || phase === "eg")
          batch.layouts.eg = await this.layout(db, "eg");
        if (phase === "import" || phase === "sg")
          batch.layouts.sg = await this.layout(db, "sg");
      }
      await db.query(
        `UPDATE ${this.table} SET status=$2,executions=$3,layouts=$4,error=$5 WHERE id=$1`,
        [
          id,
          message ? "failed" : "review",
          JSON.stringify(batch.executions),
          JSON.stringify(batch.layouts),
          message,
        ],
      );
      return true;
    });
  }
}
