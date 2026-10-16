# Prepaid Re-Class: a complete user-flow and implementation walkthrough

Updated: 16 October 2026. Start at the top and follow one accounting user's journey. At each stage, this guide explains the screen action, backend path, stored data, legacy equivalent and remaining work.

This is the main implementation guide, not a claim that production extraction or SAP acceptance is complete. The 14 October rewrite used source/documentation checks. On 15 October, the four supplied development Step Functions, five Glue job configurations, shared scripts and sampled historical executions were inspected read-only; no jobs were started and no database or AWS configuration was modified.

## Current implementation update — backend-only integration, 16 October 2026

**The four AWS Step Functions are now called unchanged.** They need only `{"env_prefix":"isg-esatp-dv"}`. The backend does not send `portalExtraction`, require `PortalEntry/PortalValidate/PortalExtract`, or expect portal receipts from those machines. No AWS definitions, Glue defaults or cloud scripts were edited, and no extraction/SAP job was started in this update.

The backend validates/normalizes immutable originals, checks hashes/schemas, coordinates disposable shared-folder copies, runs native workflows sequentially, verifies Glue success metadata and writes its own immutable receipts. Its financial evidence is **backend-normalized originals**, not an assertion that shared Aurora rows are session-isolated or equal to those originals.

**Live read-only check:** Call Card SG, Load API EG and Load API SG are compatible. The 308 machine looks up `$.extract_4_output.JobRunId`, while the preceding Glue result has `Id`. Its owner must correct this internal defect. The backend reports it before dispatching any child; it does not edit AWS.

Migration **007_prepaid_backend_source_context** adds one nullable JSONB column to child execution tracking. Applied **locally only**, after backup; 38 other Prepaid/raw table fingerprints were unchanged. Inventory remains **35 portal Prepaid + 5 raw tables = 40**, **16 functions**, **7 views**. Local migrations 001–007 are current at `127.0.0.1:5432/web_portal`; Aurora was not migrated in this update.

**Still required:** 308 correction, approval/coordination of shared Glue side effects, accepted files/totals and complete V2 adapter/remaining producers: KE24/period discovery, Call Card EG, Load Up EG/SG, Monthly Recharge, 318 charges, approved reference refresh. No approvals/integration rows were auto-enabled.

Earlier portal-branch deployment evidence is **historical and superseded**, not current configuration. See Processes 8–12 and [AWS status](PREPAID_RECLASS_AWS_VERIFICATION.md).

## Historical AWS inspection — 15 October 2026

Four supplied **active Standard source-extraction workflows** were verified in us-east-1:

- `isg-esatp-dv-prcl_cc_sg-sf`: Call Card SG.
- `isg-esatp-dv-prcl_la_eg-sf`: Load API EG.
- `isg-esatp-dv-prcl_la_sg-sf`: Load API SG.
- `isg-esatp-dv-prcl_308_ba-sf`: 308 adjustments, header then line items.

They belong to **Processes 8–12, source preparation**, not Save/Freeze/SAP delivery. At the 15 October inspection they ran shared Glue parsers into legacy-shaped Aurora source tables. The latest read-only inspection again finds the 308 handoff defect; see the current backend-only status above. The complete all-source V2 adapter remains a separate dependency.

See [verified definitions, exact placement, sampled outcomes and required adaptation](PREPAID_RECLASS_AWS_VERIFICATION.md). Earlier statements that all extraction code is unavailable are superseded: these four components exist; the **complete isolated V2 parent/bridge and remaining source coverage** are still not established. No one child should be set directly as `ingestStateMachine`.

## What Prepaid Re-Class is about

The module reviews prepaid revenue and redistributes it to the appropriate accounting categories, accounts and profit centers. It starts from KE24/COPA revenue and top-up sources, builds EG/SG layouts, records reviewed adjustments, calculates allocation and offset entries, checks the financial results, and prepares journal vouchers.

Think of the module as **“verified sources → reviewed calculation → locked reports.”** In the current workflow, SAP posting happens manually after reports are downloaded. Upload, preparation, Freeze, download and posting are different events.

### The terms you will encounter

| Term | Simple meaning in this module |
| --- | --- |
| KE24 / COPA | Source revenue and quantity data used as the starting point for reclassification. |
| Top-up sources | Call Card, Load Up, Load API, Recharge and adjustment/charge inputs used to build source totals. |
| Layout | The EG or SG accounting statement showing revenue, top-up totals, reclass destinations and variance. |
| EG / SG | The two separate legacy accounting layouts. Treat these as region/layout identifiers, not inferred geographical descriptions. |
| GP / HY, MT / BB | Legacy accounting classification codes retained in layouts and mapping rules. Their business labels must come from accounting, not guesses based on the initials. |
| Gross / net | Amount including applicable tax versus amount excluding it. Layout and reference tax rules are described at the calculation stage. |
| Allocation | Splitting a reclass amount using verified source/reference bases. |
| Offset | The opposite accounting side needed to balance the reclassification. |
| Reconciliation | Comparing calculated amounts across layout, allocation and journal outputs. |
| JV | Journal voucher: the 40-column output for manual SAP execution. |
| Freeze / staged | Lock the selected regional revision and its export format. This does not mean SAP has posted it. |
| Snapshot / revision | Snapshot is verified immutable source data; revision is an EG/SG calculation based on it. |

## The accounting user's journey

The visible workflow has only **Upload file** and **Edit & validate**. The steps below explain what happens inside those two stages; they are not additional controls to add to the UI.

```text
Open workspace
  → Upload the required files
  → Wait: preparation runs automatically
  → Review EG / SG layouts
  → Edit permitted inputs → Save
  → Review Allocation / breakdown / JV and resolve findings
  → Freeze the selected region
  → History → download frozen reports
  → Assigned operator executes/checks the JV in SAP outside the portal

Next working cycle: Edit into a new draft, or Reset → upload new sources
```

| Read in order | What you will understand | Existing process numbers |
| --- | --- | --- |
| [Before use](#1-before-the-user-opens-the-workspace) | Environment, access and operating dependencies, not accounting UI setup. | 1–4 |
| [Upload](#2-open-the-workspace-and-upload-files) | Session ownership, exact inputs and automatic queueing. | 5–7 |
| [Extract/transform](#3-extract-and-transform-the-real-sources) | Step Functions replacement for SQL Agent, four verified extractors and the remaining V2 integration gaps. | 8–11 |
| [Build layouts](#4-verify-the-output-and-build-the-layouts) | Verification, snapshots, import, gross/net totals and source baselines. | 12–14 |
| [Review/Save](#5-review-edit-and-save) | Allowed changes, versions, audit and recalculation. | 15–16 |
| [Financial outputs](#6-allocate-reconcile-and-construct-journal-vouchers) | Allocation, offsets, reconciliation, membership and JV fields. | 17–22 |
| [Freeze](#7-freeze-the-selected-region-for-manual-sap-execution) | Lock one region without sending it to SAP. | 23 |
| [History/SAP](#8-download-history-and-perform-manual-sap-work) | Frozen downloads and the separate manual operation. | 24–25 |
| [Start again](#9-edit-again-or-reset-for-the-next-preparation) | Draft cloning and Reset with retained history. | 26–27 |

**Processes 1–27 are documentation identifiers**, not SP names, API IDs or Step Functions states. Their meanings are preserved so the [senior questions](PREPAID_RECLASS_SENIOR_QUESTIONS.md) still point to the same responsibilities. For example, **23–25 means Freeze/stage → frozen report download → historical-delivery explanation**, not three automatic SAP jobs.

### How the components fit together

| Component | Its responsibility | Start reading |
| --- | --- | --- |
| React route and styles | Two-step UI, upload progress, tabs, Edit/Save/Freeze, History/Reset dialogs. | [PrepaidRoute.tsx](../../esatp-webapp/src/routes/PrepaidRoute.tsx), [prepaid.css](../../esatp-webapp/src/routes/prepaid.css) |
| Browser API helper | Requests, multipart transfers/abort/progress and decimal display. | [prepaidApi.ts](../../esatp-webapp/src/lib/prepaidApi.ts) |
| Express router | Authentication/module checks, validated commands and response/download endpoints. | [router.ts](../src/modules/prepaid/api/router.ts) |
| Workspace service | Owned uploads, source versions, requirements, preparation queue and Reset. | [workspaceService.ts](../src/modules/prepaid/application/workspaceService.ts) |
| Preparation worker | Durable AWS execution identity, polling and verified source publication. | [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts) |
| External Step Functions tasks | Real raw parsing/normalization and reference supply. | Four source extractors/Glue scripts verified; complete isolated V2 parent/bridge and remaining sources still needed. See [AWS verification](PREPAID_RECLASS_AWS_VERIFICATION.md). |
| Run service and repository | Owned revisions, locks, Save/Edit/Freeze and output reads. | [runService.ts](../src/modules/prepaid/application/runService.ts), [repository.ts](../src/modules/prepaid/infrastructure/repository.ts) |
| PostgreSQL functions/views | Financial import, totals, allocation, reconciliation, JV and immutable-data guards. | [migrations.ts](../src/modules/prepaid/infrastructure/migrations.ts), [legacyRulesMigration.ts](../src/modules/prepaid/infrastructure/legacyRulesMigration.ts) |
| S3 storage and report service | Checksummed source/output bytes and immutable frozen report ZIPs. | [prepaidStorage.ts](../src/modules/prepaid/infrastructure/prepaidStorage.ts), [reportService.ts](../src/modules/prepaid/application/reportService.ts) |

The API process and preparation worker are separate. Starting the API alone does not run the background preparation loop. PostgreSQL performs the financial calculations; Step Functions is not a substitute for those functions.

### Keep these states distinct

| State/event | What it means | What it does not mean |
| --- | --- | --- |
| Upload complete | Source bytes are stored/tracked. | File contents have been extracted or accepted as accounting data. |
| Session pending | Preparation was queued/is waiting for verified execution. | A financial run is already ready. |
| Session ready | Verified sources were published and layouts imported. | Financial validation necessarily passed. |
| Saved draft | Allowed changes and rebuilt outputs were committed. | Data is frozen or posted. |
| Revision frozen; API staged | Selected region is immutable and ready for manual execution. | Both regions froze, or SAP received/posted it. |
| Report downloaded | User obtained frozen report bytes. | SAP accepted the journal. |

Use **Implemented**, **External work**, **Approval needed**, **Intentional difference** and **Historical only** literally. Code existence is not production certification. Known legacy behavior is not always missing code; some questions are decisions or requests for accepted examples.

### One illustrative calculation to follow

This is a simplified **single-branch example**, not an approved legacy fixture. Assume layout/reference tax is 0.12, average rate is 10, all unrelated branches are zero, and all required inputs/reference evidence are valid. It omits the full set of source rows and mapping records.

| Point in the journey | Example |
| --- | --- |
| Import existing revenue | COPA net -100 gives gross -112. |
| Add top-up source | Gross 224 gives net 200. |
| Compute additional revenue | Gross 112; net 100. |
| Initialize reclass destination | Matching destination gross -112 gives zero gross variance. |
| Allocate using a 60/40 basis | Shares 0.6/0.4; allocated net 60/40 at reference tax 0.12. |
| Calculate quantities | Average rate 10 gives hits 6/4. |
| Build opposite posting side | Matching offsets provide the balancing side; total debit/credit each 100 in this simplified case. |
| Freeze/download | Preserve these reviewed results; do not claim SAP posting. |

Changing permitted inputs can rebuild all these outputs. A zero layout variance does not override missing mappings, zero rates, allocation-basis problems or an unbalanced JV.

### Reading the code references

Links with `:line` identify verified local file positions on this machine. If your editor does not jump to the line, open the filename and search for the named function/object. Shared copies can use those names even when absolute paths differ. PostgreSQL function definitions live inside TypeScript migration files; inspect them without executing migrations.

Legacy relational views define content, not necessarily the physical export job. A referenced job name is not its implementation. Source specifications, cycle data, actual reference supply and accepted export bytes still need recovery/approval.

---

## 1. Before the user opens the workspace

**On the screen:** The accounting user does not configure jobs or choose a period. This is developer/operator preparation before normal use.

**Stage result:** A migrated, authorized portal and approved configuration pointing to a real operating producer. Until that producer/configuration exists, uploads cannot demonstrate a complete working accounting pipeline.

**If this stage is blocked:** A configuration warning is not a reason to add Create Run or automatic-delivery controls. Identify the missing dependency through readiness and the senior checklist.

### Process 1 — Understand the legacy boundary

**Follow the code:** legacy [PrepaidReclassController.cs](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC/DCS2_Legacy_4_RCC/Controllers/PrepaidReclassController.cs:47) calls the EG SP through Entity Framework; [FileUpload.js](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC/DCS2_Legacy_4_RCC/Scripts/PrepaidReclass/FileUpload.js:1) is not the extraction job. Current [createApp.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/app/createApp.ts:80) mounts [router.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/api/router.ts:29). The architectural replacement is MVC/EF + SQL Server shared state → React/Express + PostgreSQL revisions + a background worker.

**Purpose:** identify what can be faithfully ported and what evidence is missing.

The legacy consists of MVC/JavaScript screens, SQL Server web procedures, financial views/helpers and dependencies on other databases and SQL Agent jobs. The supplied web upload JavaScript logs to the console; it is not a complete raw-file extraction implementation. The supplied MVC controller has seven view actions; its EG layout retrieval calls the SQL backend. Do not treat those screens as evidence that every extraction rule is available.

Source locations used in the review:

- Application: `C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC/DCS2_Legacy_4_RCC`.
- SQL exports: `C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB`, specifically `etl_db_web/etl_db_web` and `DCSTDIR1/DCSTDIR1`.

The exports do **not** establish the full contents and refresh processes of `sdbTDIR1_Prepaid`, `dgS4HANA_TDIR1`, or the referenced SQL Agent job steps. Those dependencies must be recovered or replaced with verified specifications.

**Legacy inventory:** 20 web procedures plus 14 supporting procedures = **34 procedures**, including two historical `_BKP` variants; **32 non-backup procedures**. The modern implementation consolidates their responsibilities instead of recreating every SQL Server name.

**Still needed — legacy/source discovery:** recover job definitions, underlying source-view SQL, report layouts, representative inputs/outputs and reference refresh rules. This is source investigation, not simply another portal API.

### Process 2 — Install and verify the current database

**Follow the code:** [migratePrepaid.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/migratePrepaid.ts:1) applies the migration sequence; [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:2) contains the base SQL. [prepaidWorker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/prepaidWorker.ts:33) refuses to operate without the later required schema objects. Read migration SQL for understanding; running it is a deployment action, not a prerequisite for reading this guide.

**Purpose:** provide durable, isolated Prepaid data and immutable financial history.

Current stack: TypeScript/Express API, PostgreSQL financial functions, React/TypeScript UI, S3 storage and a separate preparation worker using AWS Step Functions.

Current migration sources, in order:

1. [migrations.ts](../src/modules/prepaid/infrastructure/migrations.ts): base schema and financial functions.
2. [workspaceMigration.ts](../src/modules/prepaid/infrastructure/workspaceMigration.ts): upload-session/preparation/manual-staging flow.
3. [consistencyMigration.ts](../src/modules/prepaid/infrastructure/consistencyMigration.ts): snapshot authority, stale-source protections and report consistency.
4. [legacyRulesMigration.ts](../src/modules/prepaid/infrastructure/legacyRulesMigration.ts): original EG source totals, optional split policy and reference membership.
5. [rawSourceMigration.ts](../src/modules/prepaid/infrastructure/rawSourceMigration.ts): the five raw extraction targets used by the four supplied AWS workflows. Creates missing targets and validates existing column names, types, identity settings and the line-item unique index without rewriting existing source rows.
6. [sourceExtractionMigration.ts](../src/modules/prepaid/infrastructure/sourceExtractionMigration.ts): per-preparation child tracking; previously applied locally and to Aurora.
7. [sourceBackendMigration.ts](../src/modules/prepaid/infrastructure/sourceBackendMigration.ts): backend-private identities/artifacts/staging context, separate from native AWS input; applied locally only in this update.

Migrations 001–007 define **35 portal Prepaid tables (including the ledger) + 5 raw extraction tables = 40 required tables**, plus **16 portal PostgreSQL functions** and **7 portal views**. These are not one-for-one SQL Server table/SP replicas. The dated 15 October results below describe the earlier 001–005 inventory; the 16 October source-extraction follow-up adds one execution table without changing existing raw or financial rows.

**Check the active target every time.** Active `.env` uses local PostgreSQL 17 at `127.0.0.1:5432`, database/schema `web_portal`, user `portal`; sandbox/RDS remain commented. Migration 007 was local only. The `:local` suffix means TypeScript execution, **not** a guarantee of a local database. Check before migrating; do not copy credentials into documentation.

The full table/function/view inventory is in [Database reference](#database-reference) at the end, so it does not interrupt the walkthrough.

**Safe deployment sequence:** confirm the target, back it up, build the application, apply the Prepaid migrations, verify the ledger/objects, then start the worker. For an approved local target:

```powershell
npm run build
npm run db:migrate:prepaid:local
npm run local
```

Run `npm run worker:prepaid:local` in a separate terminal. These are deployment instructions, **not commands executed during this documentation consolidation**. The compiled alternatives are `db:migrate:prepaid` and `worker:prepaid`, after building. Compose worker/migration services use the opt-in `prepaid` profile.

Existing private backups are under `docs/db-backups/`; do not delete them or commit them. Prior verification recorded unchanged fingerprints for the 25 non-Prepaid tables.

#### 15 October 2026 — applied and verified database migrations

| Target | Applied in this change | Verified final inventory |
| --- | --- | --- |
| Active Aurora: database `postgres`, schema `web_portal` | 001–005; previously no portal `prepaid_*` objects were installed. The five raw targets already existed and were retained. | 34 portal Prepaid tables + 5 required raw tables; 16 functions; 7 views; all five migration IDs. |
| Saved local PostgreSQL: `localhost:5432`, database/schema `web_portal` | 005 only; 001–004 were already installed. | Same 39 required tables, 16 functions, 7 views and five migration IDs. |

- **Backups:** available Aurora cluster snapshot `esatp-prepaid-before-migrations-2026-10-15t10-37-50-358z`; local custom-format dump `docs/db-backups/web_portal-before-raw-sources-005-20261015.dump` (archive listing verified). The manual Aurora snapshot is retained for recovery and can incur storage charges; do not delete it without the owner's retention decision.
- **Non-destructive checks:** all 25 existing non-Prepaid portal tables plus the five raw targets and separate mixed-case header table had unchanged row counts and paired row fingerprints after the Aurora migration. All 133 raw column definitions, including the separate header table, matched the pre-migration inventory. Eight canonical stage tables have their snapshot FK, composite PK and snapshot guard trigger.
- **Repeatability:** repeating the migrations on both targets applied **none**; the table/column/index validation passed.
- **Tests:** build and 73 selected tests passed (all Prepaid tests plus OpenAPI), including fresh install, existing-data preservation, repeat runs, schema-drift detection and atomic rollback. A broader suite separately reported four failures in existing `auth.test.ts` email-mapping expectations; no authentication source or tests were changed here.
- **Evidence:** [Aurora object inventory and before/after fingerprints](prepaid/migration-verification/2026-10-15-aurora.json). It contains schema metadata/hashes, not source business rows or passwords.
- **Connection boundary:** Aurora migration used the explicitly configured RDS Data API because direct PostgreSQL TCP access from this machine timed out. This does **not** fix the API/worker's TCP route to Aurora. `.env`, security groups and networking were not modified.

**Still needed — deployment/setup:** resolve/verify the API and worker's database TCP connectivity for the intended runtime, deploy the approved application image and operate the workers. The ingestion bridge and remaining source coverage in Processes 8–12 are separate work; creating these tables does not complete that integration. No UI controls, source processing jobs or SAP dispatch were added or executed by this migration task.

### Process 3 — Authenticate and authorize access

**Trace:** authenticated request → Prepaid module check → owned session/run lookup → permitted action. [router.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/api/router.ts:43) checks the module; [rbac.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/rbac.ts:34) defines module authorization; [repository.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/repository.ts:53) implements run ownership. Legacy [webdcPrepaidSystemsUcv_010.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystemsUcv_010.View.sql:8) is the specific special-control evidence to discuss with your senior.

**Purpose:** make the workspace and its financial records accessible only to authorized users.

All Prepaid routes require authentication and module access. Run/session/report operations also enforce ownership: an admin role does not automatically mean access to every other user's run. Integration updates are admin-only. Direct SQL does not provide the API's complete ownership and current-source checks.

**Current code:** [router.ts](../src/modules/prepaid/api/router.ts), [workspaceService.ts](../src/modules/prepaid/application/workspaceService.ts), [runService.ts](../src/modules/prepaid/application/runService.ts).

**Legacy equivalent:** group-control views such as `Ucv`, `Ucv_010` and SG equivalents. The special legacy unfreeze permission is not fully established by the available exports.

**Still needed — approval, then possibly API/RBAC:** decide whether the legacy special unfreeze group must be reproduced. Current Edit authorization exists; do not invent a new permission model without approval.

### Process 4 — Configure the operating dependencies, not the JV business rules

**Trace:** administrator `PUT /integration` → validated configuration → `prepaid_integrations`. [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:84) persists it; [integrationReadiness.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/integrationReadiness.ts:30) diagnoses missing/invalid settings. Legacy [sp_Prepaid1_Extract.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_Extract.StoredProcedure.sql:24) supplies a SQL Agent name, not an AWS deployment. Configuring a valid name does not deploy its tasks.

**Purpose:** connect the existing financial implementation to a real producer and an approved physical output format.

**Who does this:** developer/operator and authorized administrator, once per environment or when the approved configuration changes. The accounting user does not perform this as a third UI step.

#### Is this already indicated in the legacy?

**Partly.** The supplied SQL identifies job names and JV business content. It assumes other operating dependencies exist; it does not contain enough evidence to reproduce all of them automatically.

| Setting/responsibility | What the supplied legacy actually says | Current implementation / action |
| --- | --- | --- |
| Trigger extraction | `sp_Prepaid1_Extract` calls SQL Agent job `Prepaid_Reclass_Preload_P02_Extract_04Mnt` and polls it. | Session preparation/worker implement triggering, durable identities and verified completion using a Standard V2 adapter. The raw job steps and deployed AWS machine are still needed. |
| Trigger export/delivery | EG/SG Freeze procedures call `Prepaid_Reclass_Preload_P10_EG_Only_AdHoc` and `Prepaid_Reclass_Preload_P10_SG_Only_AdHoc`. | Intentionally replaced by regional manual staging. These SQL Agent names are evidence, not AWS settings or instructions to auto-post. |
| JV columns/values | `webPrepaidSystems_JV01` plus EG/SG horizontal views define 40 fields, date/value expressions and amount filtering. | Already implemented in `prepaid_build_outputs` and `jvHeaders`: month-end dates, SA/GLOB/PHP, TOP-UP, regional text, posting keys, amount/quantity and classification fields. |
| File delimiter, encoding, line ending | JV SQL defines a relational result, not how the export job writes bytes. | Must recover the export job/file specification or obtain an approved format. Layout's `Delimiter` column is not proof of a physical JV file delimiter. |
| Required billing cycles | `zPARAM_ICCBS_AllBillCycles` and `dczPARAM_ICCBS_AllBillCycles` define cycle/month/run-date columns, but the supplied table files contain no cycle rows. | Configure approved actual `expectedCycles`. Legacy cycle column allows three characters; mapping to the current two-digit cycle contract needs source evidence, not arbitrary truncation. |
| Producer/runtime configuration | SQL Server databases and SQL Agent are assumed available. No AWS ARN/name, bucket/role or V2 manifest appears in the supplied workflow. | Deploy/configure the real producer and runtime access for the new technology stack. |

**Conclusion:** do not reimplement the known JV content as a manual setup task—it is already code. Do not pretend the unknown export job bytes, cycle values or AWS deployment are specified by a job name.

Evidence files in the SQL export directories from Process 1:

- `etl_db_web/etl_db_web/dbo.sp_Prepaid1_Extract.StoredProcedure.sql`.
- `etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Freeze.StoredProcedure.sql` and SG equivalent.
- `DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV01.View.sql`, `dbo.webPrepaidSystems_JV_EGHor.View.sql`, `dbo.webPrepaidSystems_JV_SGHor.View.sql`.
- `DCSTDIR1/DCSTDIR1/dbo.zPARAM_ICCBS_AllBillCycles.Table.sql`, `dbo.dczPARAM_ICCBS_AllBillCycles.Table.sql`.

#### What the current setup APIs do

All paths are relative to `/api/workflows/prepaid`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/readiness` | Read schema/config checks and the legacy evidence; no database write or AWS dispatch. |
| GET | `/integration` | Read saved runtime settings. |
| PUT | `/integration` | Authorized administrator saves validated settings. |

Readiness now also returns **`legacyBasis`**: the actual extraction/Freeze job names, cycle-table evidence and the implemented 40-column JV contract. Its flags explicitly say job steps, cycle rows, AWS machine definition and physical export settings are unavailable in the supplied legacy.

[Integration readiness code](../src/modules/prepaid/domain/integrationReadiness.ts) provides actionable missing/invalid messages. Invalid optional settings such as an unknown split policy now have their own invalid check; they cannot leave all visible checks green while uploads remain blocked. Valid settings are described as configured, not live-verified.

This metadata does not execute a legacy job, approve a mapping or install a guessed configuration. `externalVerification` remains `not_verified`.

#### What you must supply, and in what order

1. Recover/implement the real raw-source producer described in Stage 3.
2. Deploy its Standard V2 workflow. Set `ingestStateMachine` to the **actual deployed machine name**, not the old SQL Agent name unless a machine with that name was deliberately deployed.
3. Obtain the actual required billing-cycle list from source owners and set `expectedCycles`.
4. Recover/approve the physical JV export specification. Set `format.profile`, `format.delimiter`, `format.lineEnding`, `format.encoding` and the real approval assertion.
5. Configure the application/worker's approved S3 bucket, AWS region and runtime role/credentials. Verify source/output access and execution Start/Describe permissions.
6. Save configuration using the existing admin `PUT /integration`, check `GET /readiness`, then verify the pipeline using real inputs.
7. Use a fresh preparation after configuration changes; reviewed snapshots/frozen reports retain captured settings.

Manual staging requires only `ingestStateMachine`, `expectedCycles` and `format`. `deliveryStateMachine`, `target`, `upstreamPrefix` and format reversal capability are optional historical-delivery settings—not prerequisites to the refined workflow.

`format.approved: true` must represent real approval. It is not an approval system and not proof of SAP acceptance. No ready/verified configuration is inserted automatically.

The older warning “Configure verified Prepaid ingestion, cycle coverage and SAP delivery before creating a run” described an earlier design. Current processing starts automatically after complete uploads and uses manual SAP staging; no Create Run/automatic-delivery panel should be added.

At the last recorded local database check, `prepaid_integrations` contained zero rows. This is historical verification, not a new database inspection on 13 October.

**Still needed — source/task code + deployment/setup + approval:** real producer, real operating configuration and acceptance. **Already implemented — API/financial SQL:** configuration validation/persistence, readiness diagnostics and JV business content. No additional unconditional SP or setup UI is required.

---

## 2. Open the workspace and upload files

**On the screen:** Open Prepaid Re-Class. In Upload file, browse/drop the required files, watch upload progress and remove a completed input when allowed.

**Stage result:** The first accepted file creates an owned session. The last required file queues preparation and changes the session to pending; the browser polls automatically.

**If this stage is blocked:** Reject unrecognized names/cycles. Do not upload/change sources during pending preparation. Cancelling the browser transfer is not proof the server never committed it: the UI refreshes workspace state.

### Process 5 — Restore the user's workspace without changing financial state

**Trace:** [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:335) `refreshWorkspace()` → `GET /workspace` → [workspaceService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/workspaceService.ts:27) `state()` → restore session/run/files. UI stage is selected from imported EG/SG state. Read-only restoration does not start extraction or create a new run. Legacy [sp_Prepaid1_EGLayout.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout.StoredProcedure.sql:8) recomputed while reading; the new GET intentionally does not.

**Purpose:** show the current session, files and progress.

API: `GET /workspace`. Viewing it is read-only. The first accepted upload creates a session; merely visiting the screen does not create a financial run.

**UI code:** [PrepaidRoute.tsx](../../esatp-webapp/src/routes/PrepaidRoute.tsx), [prepaid.css](../../esatp-webapp/src/routes/prepaid.css), [prepaidApi.ts](../../esatp-webapp/src/lib/prepaidApi.ts).

The refined UI has exactly two steps: **Upload file** and **Edit & validate**. It has History and Reset, upload guidelines/drop zone, empty/uploading/completed-file states, EG/SG tabs, Allocation/JV selectors, Edit/Save/Freeze, notifications and confirmation dialogs.

Do not restore the superseded period picker, Create Run section, Process/Import panel, manifest input, mandatory reason modal, separate Validate Again panel or automatic SAP delivery panel. The UI selects no accounting period: the producer discovers it from KE24.

**Still needed — acceptance:** a real-input/browser comparison against the supplied wireframes. Earlier build and component tests are not proof of exact pixel equivalence.

### Process 6 — Accept the required inputs and track source versions

**Trace:** [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:451) `startUpload()` → [prepaidApi.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/../esatp-webapp/src/lib/prepaidApi.ts:82) `uploadSource()` → `POST /workspace/sources/:code` → [workspaceService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/workspaceService.ts:173) → S3 bytes + active `prepaid_session_files`. [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:13) defines codes/names; [prepaidStorage.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/prepaidStorage.ts:40) stores checksummed objects. “Upload complete” means storage succeeded, not accounting preparation.

**Purpose:** build a complete, identifiable input set, rather than calculate from whichever files happen to exist.

APIs:

- `POST /workspace/sources/:code`: multipart upload using the accepted code.
- `DELETE /workspace/sources/:code`: remove an active input when allowed.

The current accepted files are:

| Code | Required filename |
| --- | --- |
| `ke24` | `KE24.XLSX` |
| `callcard_eg` | `CALLCARD_EG.XLSX` |
| `callcard_sg` | `CALLCARD_SG.XLSX` |
| `load_up_eg` | `LOAD UP_EG.XLSX` |
| `load_up_sg` | `Load UP_SG.XLSX` |
| `load_api_eg` | `LOAD API_EG.XLSX` |
| `load_api_sg` | `Load API_SG.XLSX` |
| `monthly_recharge` | `DL_Monthly_Recharge_summary_report.csv` |
| `308_XX`, each configured cycle | `308. Billed Adjustments Monthly Summary Report_G_BCXX.XLSX` |
| `318_XX`, each configured cycle | `318. Billed Charges Summary Report_G_BCXX.XLSX` |

Filename comparison is case-insensitive. Total required uploads = **8 + 2 × configured cycle count**. Two configured cycles mean 12 files, but that is an example, not approved coverage.

There is no reference upload code, `411` upload code or `sap_glbilled.txt` upload code in the current contract. Those names appear in the original wireframe's example guidelines; do not claim they are supported or secretly parse them. Visual fidelity does not establish a source requirement.

Files are stored with IDs, keys and SHA-256 hashes. A change advances the source version. Pending preparation restricts source changes/Reset; frozen-source replacement requires the appropriate draft/reset flow.

**Still needed — producer code:** real XLSX/CSV parsing is not done by this upload endpoint. Filename validation and S3 upload do not constitute extraction.

Existing sample pack: `C:/Users/rccco/Downloads/Prepaid-Reclass-Samples-2026-09`. Its synthetic upload files and eight adapter fixtures exercise contracts only; they are not certified production inputs or approved reference mappings.

### Process 7 — Queue preparation automatically when coverage is complete

**Trace:** upload transaction → [workspaceService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/workspaceService.ts:266) `enqueue()` checks all required codes → `prepaid_preparation_jobs` with persisted execution name → session `pending`. [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:426) polls workspace state every four seconds while pending. This replaces the need for a separate user Extract button, not the extraction task logic. Legacy trigger: [sp_Prepaid1_Extract.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_Extract.StoredProcedure.sql:39).

**Purpose:** transition from uploaded files to a reproducible background preparation.

The final required upload automatically queues preparation. `POST /workspace/prepare` exists for controlled preparation/retry behavior, but does not require an extra Process button in the refined UI.

Key identities:

| ID/state | Meaning |
| --- | --- |
| Session ID | Owned upload workspace, created before the period is known. |
| Source version | Which exact input set is being prepared. |
| Preparation ID | One background preparation attempt and persisted execution identity. |
| Run ID | Owned financial period container, created/reused after period discovery. |
| Snapshot ID | Immutable verified canonical source data plus configuration. |
| Regional revision ID/version | EG or SG draft/frozen calculation and optimistic concurrency token. |

Changing files must not silently reuse a previously reviewed snapshot. Mutations use consistent lock order: workspace advisory lock → session → run → EG/SG revisions. Snapshot context binds the session, version and source identities.

**Current code:** workspace service and [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts).

**Legacy equivalent:** `sp_Prepaid1_Extract` started `Prepaid_Reclass_Preload_P02_Extract_04Mnt`, set processing state and polled. Its timeout/flag clearing did not establish successful extraction. The modern worker verifies terminal execution and output evidence instead.

---

## 3. Extract and transform the real sources

**On the screen:** Wait for automatic preparation. There is no Extract button, manual period selection or manifest editor in the refined UI.

**Stage result:** A Standard execution produces one accounting period and eight canonical JSONL datasets plus a manifest identifying the exact execution and source bytes.

**If this stage is blocked:** Four deployed source workflows and their shared XLSX parser are now verified. The main remaining gap is safe session/run isolation, missing source coverage and the complete canonical V2 parent/bridge; an individual extractor is not that adapter.

### Process 8 — Backend preparation calls existing extraction workflows

**User action:** none after all required uploads. The two-step UI is unchanged.

**Legacy:** `sp_Prepaid1_Extract` starts/waits for SQL Agent extraction. [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts) coordinates AWS execution identities and a renewable preparation lease instead.

**Current code:** [sourceExtractionWorker.ts](../src/modules/prepaid/application/sourceExtractionWorker.ts), `advance()`:

1. Read all four definitions and Glue settings. Confirm native order, input folder/pattern and target tables. Inspect only; never deploy.
2. Persist the child name and **only** `{env_prefix}` in `prepaid_source_extractions.execution_input`. Save portal identities, normalizer revision, outputs and staging state separately in `context`.
3. Hash-check exact originals, parse locally, validate records and write immutable session-specific JSONL fragments. Invalid financial inputs stop that source before dispatch.
4. Acquire the conditional S3 lock `prepaid_reclass/portal-coordination/extract.lock.json`. [legacyLanding.ts](../src/modules/prepaid/infrastructure/legacyLanding.ts) coordinates portal workers across databases.
5. Check running workflows/Glue jobs and conflicting matching inbound files. Stage only verified **disposable copies** for this child in `prepaid_reclass/inbound/`. Never overwrite foreign files or expose originals to jobs that move/delete inputs.
6. Start with `{"env_prefix":"isg-esatp-dv"}`. Native tasks call Glue 1 (Call Card SG), 2 (Load API EG), 3 (Load API SG), or 4 then 5 (308). One child runs at a time.
7. Poll AWS. Recover uncertain starts with the same saved name/input, without re-staging copies Glue may have moved. Running/unknown outcomes retain the lock; no timeout-based stealing.
8. Verify exact native input, success, final Glue `JobName/Id/JobRunState`, and backend JSONL hashes/counts. AWS does **not** return a portal receipt.
9. Wait for active Glue work/cancellation to settle. Conditionally clean only owned/hash-verified copies and release the lock; originals stay intact. Record the verified backend receipt.
10. Pass backend receipt descriptors to the **complete V2 adapter**. It must still supply all eight datasets/final manifest. Compare covered records before making a snapshot ready.

```text
Uploads -> durable preparation -> backend validates originals/native contracts
  -> lock/stage -> native workflow -> verify/cleanup
       sequentially: CC SG -> Load API EG -> Load API SG -> 308
  -> backend extractionReceipts -> complete V2 adapter + remaining producers
  -> eight datasets/manifest -> verification -> layouts ready
```

**“Portal validation” means backend checks**, not an AWS state/parameter. [sourceExtraction.ts](../src/modules/prepaid/domain/sourceExtraction.ts) maps/validates native contracts; [sourceJobInspector.ts](../src/modules/prepaid/infrastructure/sourceJobInspector.ts) reads Glue settings/activity. No AWS script override.

**Safety boundary:** unchanged jobs still move disposable copies and replace/write shared Aurora raw rows through their existing connection—even when portal PostgreSQL is local. Backend fragments are independently session-scoped; they are **not** proof of shared-row isolation/equality. Enable `sharedWritesApproved: true` only with owner approval. External/manual producers do not automatically honor the portal lock: coordinate them or arrange isolated infrastructure. Operators must inspect saved execution IDs, Glue activity and owned copies before reconciling an orphaned lock; do not simply delete it.

**Current blocker:** all four are preflighted first. The live 308 `JobRunId` defect blocks the sequence until its owner corrects it. The backend does not patch/replace the workflow.

**Diagnostics:** `GET /api/workflows/prepaid/workspace/extractions` shows owned progress. `pnpm verify:prepaid:sources` checks compatibility read-only. Former `deploy:prepaid:sources -- --apply` is disabled.

**Still needed:** 308 correction, shared-operation approval, accepted files/totals, complete V2 adapter and remaining producers. No child is the complete `ingestStateMachine`; the API rejects that mistake.

### Process 9 — Apply source transformations, not duplicate financial SQL

**Backend implementation:** [sourceNormalizer.ts](../src/modules/prepaid/infrastructure/sourceNormalizer.ts) runs [normalize_source.py](../infrastructure/prepaid/normalize_source.py) as a local bounded subprocess. It imports pure helpers in [portal_source_extract.py](../infrastructure/prepaid/portal_source_extract.py), not its historical Glue entry point. No boto3/awsglue or AWS deployment is needed. Rules follow inspected job arguments/source views/legacy imports, tested with Python fixtures and a real backend subprocess/XLSX test.

| Source | Implemented parsing/normalization | Legacy connection |
| --- | --- | --- |
| Call Card SG | `CALLCARD` sheet; skip four rows; trade column 2/internal column 7; use the latest valid dated row, not the sum of prior months. Include `sourcePeriod` for later KE24 verification. Reject ambiguous latest-month rows. | `WebdcCallCard_SG_TotalGrossAmout` orders valid dates; `sp_Prepaid1_SGLayout_Import_01_Copa` selects `MAX(MonthNo)`. |
| Load API EG | First sheet; skip three rows; amount column 6; select Type EG; decimal aggregate to two places. | Glue extract_2 and `WebdcLoadAPI_TotalAmount`, consumed by EG import. |
| Load API SG | First sheet; skip two rows; amount column 9, preserving the discard-column offsets; select Type SG. | Glue extract_3 and `WebdcLoadAPI_SG_TotalAmount`, consumed by SG import. |
| 308 | Read Cycle Code/Year/Instance first, then locate all ten detail headers. Associate both phases by the exact source UUID/key/hash and actual `308_XX` code, not wildcard discovery position. Emit PHP adjustment records and preserve cycle evidence. | Existing header/detail source views and Glue extract_4/extract_5. `Cycle Instance` is not guessed to be an accounting month. |

Exact S3 key/hash checks, ZIP expansion/dimension bounds, uncached-formula rejection and immutable output writes are implemented. Parsing fails on ambiguous financial headers or malformed amounts rather than inventing a successful result. The stricter exact-header checks and decimal arithmetic are intentional safety differences from the old fuzzy/float pipeline; accepted source files and accounting totals still require verification.

Output fragments deliberately omit `period`: KE24 must establish it. [sourceExtractionBridge.ts](../src/modules/prepaid/application/sourceExtractionBridge.ts) binds that verified period, checks SG source period and 308 cycle/year evidence, and compares the four sources' canonical rows as a multiset. Omitted, changed or additional covered records fail before a ready snapshot is committed. Other source families are not fabricated by this bridge.

**Trace for these four sources:** immutable originals → hash check → local backend parser/source selection → session-specific JSONL. Separate unchanged AWS workflows still execute shared raw-table jobs. [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:50) defines the required output records; [sp_Prepaid1_EGLayout_Import_01_Copa.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Import_01_Copa.StoredProcedure.sql:8) and [sp_Prepaid1_SGLayout_Import_01_Copa.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Import_01_Copa.StoredProcedure.sql:8) identify legacy source consumers. Four source-specific Glue extractors/shared scripts have now been verified; their [inspection copies and compatibility gaps](PREPAID_RECLASS_AWS_VERIFICATION.md) show what can be reused. The complete portal-compatible V2 producer is still missing and is not hidden inside `prepaid_import_layout`.

**Purpose:** reproduce the legacy producer's filtering, grouping, periods, signs and source amounts before PostgreSQL calculates reclassification.

The distinction answers the extraction/Glue question:

| Work | Where it belongs | Current position |
| --- | --- | --- |
| Read XLSX/CSV, obtain external source/reference data | Producer task code or recovered ETL jobs | Four source-specific Glue extractors verified; remaining families and safe V2 integration still needed. |
| Select correct period/cycle/month, normalize columns, validate totals/signs | Producer transformations | Legacy source specifications and fixtures still needed. |
| Layout totals, allocation, reconciliation and JV calculations | PostgreSQL functions/views | Implemented; accounting differences still need acceptance. |
| Run tasks, pass identities, wait, fail/retry and publish a manifest | Step Functions orchestration | Caller/contract exists; deploy real workflow. |

**Glue is already used by the four provided AWS workflows.** Their definitions, job defaults and shared parser scripts were verified on 15 October; do not recreate those components from scratch merely because they were absent from the original legacy export. The backend handles portal validation, owned-copy staging, normalization and receipts. The internal 308 defect remains with its owner; shared raw writes require explicit approval. Other source tasks may use an appropriate verified runtime. Do not duplicate the portal's financial SQL in Glue.

Legacy source views needing verified producer equivalents:

| Input family | Legacy views |
| --- | --- |
| COPA | `webdcKE24_EC_COPAValues` |
| Call Card | `WebdcCallCard_TotalGrossAmout`, `WebdcCallCard_SG_TotalGrossAmout` |
| Load Up | `WebdcLoadUp_TotalAmount`, `WebdcLoadUp_SG_TotalAmount` |
| Load API | `WebdcLoadAPI_TotalAmount`, `WebdcLoadAPI_SG_TotalAmount` |
| Recharge | `WebRechargeSumamry_TotalAmount`, `WebRechargeSumamry_SG_TotalAmount` |
| AMAXCE | `WebAmaxee_TotalAmount`, `WebAmaxee_SG_TotalAmount` |

SG has latest-Call-Card-month behavior. The producer must select the approved source month; portal checks alone cannot reconstruct missing raw producer rules.

#### Local parsing runtime setup

The worker needs Python with pinned `infrastructure/prepaid/requirements-backend.txt`. Both Dockerfiles install/include this helper; nothing needs deploying inside the four workflows.

```powershell
python -m venv .venv-prepaid
./.venv-prepaid/Scripts/python.exe -m pip install -r infrastructure/prepaid/requirements-backend.txt
```

The worker uses repository `.venv-prepaid`, or `PREPAID_PYTHON_EXECUTABLE` if set to another installed interpreter. XLSX bytes enter stdin; JSON leaves stdout; no AWS/database access. Missing Python/invalid inputs are errors, never guessed empty data.

### Process 10 — Obtain and normalize the SAP reference mapping

**Trace:** approved ZTF0455S export → [referenceProvider.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/referenceProvider.ts:23) `load()` → [referenceConverter.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/referenceConverter.ts:7) `convertLegacyReference()` → canonical reference records/provenance. Legacy [ZTF0455S.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.ZTF0455S.View.sql:10) reads the external mapping database. The helper reads verified bytes; it does not schedule the real mapping refresh or invent approval.

**Purpose:** map revenue to account, brand/CFU/sub-product, tax rate, average rate and UOM.

Legacy reference depends on `dgS4HANA_TDIR1.dbo.ZTF0455S`, client `300`. Canonical mapping uses company `GLOB`; confirm this filter because the legacy view did not explicitly establish that same restriction.

Implemented utilities:

- [referenceProvider.ts](../src/modules/prepaid/application/referenceProvider.ts): loads an approved-prefix S3 export, verifies its hash and source row count, bounds streaming reads to 20 MiB and returns normalized data/provenance.
- [convertPrepaidReference.ts](../src/convertPrepaidReference.ts): offline JSONL converter. It does not read the portal database or call AWS, and refuses to overwrite existing outputs.

Example for an actual approved export, with existing directories:

```powershell
node --import tsx src/convertPrepaidReference.ts C:/verified/ztf0455s.jsonl 2026-09 C:/verified/reference.jsonl
```

It writes normalized data plus report/provenance. Transport verification is not accounting approval; the provider deliberately does not certify `verifiedMappingSource`.

| Legacy field | Canonical field |
| --- | --- |
| `MANDT`, `BUKRS`, `HKONT` | `client`, `company`, `cost_element` (account padding retained) |
| `WWBRD`, `WWSPA`, `WWST`, `SPB` | `brand`, `cfu`, `revenue_type`, `sub_product` |
| `TAXRATE`, `AVERATE`, `DUOM` | `tax_rate`, `average_rate`, `uom` |
| `BRAND` | Optional `source_brand`; distinct from `WWBRD`. |

Original metadata, including fields such as `PSTKY`, is retained in converter provenance where supplied.

**Still needed — data source/producer integration/approval:** supply the real export and refresh ownership, connect the existing provider to the deployed producer and approve mapping semantics. The reader/converter themselves are implemented.

### Process 11 — Publish the exact V2 preparation contract

**Additional contract when `sourceExtraction` is enabled:** the V2 input includes `extractionReceipts`, one per supplied child, containing its workflow, execution ARN, receipt key and verified artifact descriptors. The final V2 manifest must echo that array unchanged. Read the fragments, bind the accounting period discovered from KE24, and publish their records into canonical `callcard` (SG portion), `loadapi` (EG/SG) and `adjustments`. Supply the other source families from their actual producers; do not fill them with guessed empty datasets. The backend independently rereads checksummed fragments and compares all covered canonical records before committing a ready snapshot. Header Cycle Code/Year/Instance are preserved and structurally checked; the undocumented cross-year/window rules are not inferred from the old job name.

Current **backend-only** `sourceExtraction` configuration is in [AWS status](PREPAID_RECLASS_AWS_VERIFICATION.md). Old `scriptSha256/scriptLocation` settings are not accepted for new native dispatch. No live integration row was seeded or approved automatically. A full configuration still needs the real complete adapter name, approved billing cycles and export settings. In Aurora, verification found zero integration rows, so uploads cannot yet demonstrate a full ready accounting run. This is an explicit dependency, not a hidden success state.

Worker IAM needs `states:DescribeStateMachine`, `StartExecution`, `DescribeExecution`, `ListExecutions`; `glue:GetJob`, `GetJobRuns`; S3 read/list plus conditional lock/copy write/delete and immutable preparation output writes; relevant KMS access if required. Existing Glue roles retain their original permissions. No definition-update permission is needed. IAM/AWS definitions were not changed.

**Follow the contract:** [preparationWorker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/preparationWorker.ts:77) constructs the input; [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:207) defines `sessionManifestSchema`; [prepaidStorage.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/prepaidStorage.ts:65) verifies JSONL hashes/counts. The workflow returns a manifest key, not accounting amounts directly to the UI. Its execution ARN must be present in the manifest it produces.

**Purpose:** let the portal prove the output belongs to this session and these source bytes.

Contract source: [contracts.ts](../src/modules/prepaid/domain/contracts.ts). V1 run ingestion still exists for compatibility; **new UI preparation uses V2**.

Execution input has:

```text
contractVersion: 2
sessionId, workspaceId, preparationId, sourceVersion
bucket, outputPrefix, expectedCycles
discoverPeriodFrom: ke24
sources: [{ id, code, key, sha256 }]
```

The input has **no user-selected period or run ID**. KE24 must determine exactly one valid period.

Successful execution output is `{ contractVersion: 2, manifestKey }`. The referenced manifest carries:

```text
contractVersion: 2
sessionId, workspaceId, preparationId, sourceVersion
period, executionArn
sourceFiles: [{ id, sha256 }]
coverage: [{ cycle, adjustments: true, charges: true }]
datasets: [{ name, key, sha256, rowCount }]
```

Exactly eight UTF-8 JSONL datasets must be described:

| Dataset | Fields in addition to `period` |
| --- | --- |
| `ke24` | `brand, cfu, revenue_type, cost_element, profit_center, sub_product, uom, reference_document, amount, quantity, currency` |
| `callcard` | `region, kind, month_no, amount` |
| `loadup`, `loadapi` | `region, amount` |
| `recharge` | `customer_type, method, channel, amount` |
| `adjustments`, `charges` | `cycle, customer_type, code, amount, currency` |
| `reference` | `client, company, cost_element, brand, cfu, revenue_type, sub_product, tax_rate, average_rate, uom`; optional `source_brand` |

Important constraints:

- `period` is `YYYY-MM`; monetary values/quantities/rates are decimal **strings**, not JSON floats. Money accepts up to 28 integer and 10 fractional digits.
- `region` is `eg`/`sg`; Call Card kind is `trade`/`internal`, month 1–12.
- Currency fields are `PHP`; reference client/company are `300`/`GLOB`.
- Tax rate is a fraction between 0 and 1, not percentage 12; average rate cannot be negative. Account is 1–10 digits.
- KE24 and reference must be nonempty. Other datasets may be verified zero-row datasets, not omitted files or fabricated amounts.
- SHA-256 values and row counts must be calculated from actual output bytes/records.
- IDs, sources, coverage and descriptor names must be exact and nonduplicated. Output descriptor keys must belong to the permitted execution prefix; source identity is checked against the persisted uploaded-file set.

**Still needed — producer implementation:** return this contract from the real pipeline. Do not copy fixture UUIDs/ARNs/hashes into live manifests.

---

## 4. Verify the output and build the layouts

**On the screen:** After preparation succeeds, Edit & validate opens with imported EG/SG values. If preparation fails, the UI reports the failure instead of presenting invented accounting values.

**Stage result:** A verified immutable source snapshot and imported regional drafts. Preparation-ready does not imply financially freezable.

**If this stage is blocked:** Checksum, identity, period, coverage or schema errors reject publication. Correct the producer/source input; do not relax verification to get a ready status.

### Process 12 — Verify before publishing any financial source

**Trace:** successful AWS execution → exact input/output comparison → manifest/schema/hash/period checks → one database transaction. [preparationWorker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/preparationWorker.ts:109) verifies execution; line 189 starts publication; later calls import/build for both regions. Writes include snapshots, staging, snapshot context, run and regional revisions. A rejected dataset cannot be published as a successful financial source.

**Purpose:** prevent wrong-period, stale, incomplete or tampered data from becoming a ready snapshot.

The worker compares described AWS execution input with persisted input, verifies execution identity, manifest identity, exact source hashes and cycle coverage, output prefixes, dataset hashes/counts/schema and all row periods. It validates each row period. For SG Call Card, it tracks the maximum month, skips other months during staging, and rejects a maximum month different from the discovered period. Raw month-selection rules still need producer verification.

Only after verification does one transaction publish the snapshot/context and initialize/import/build EG and SG. A same-period owned run can be reused; configuration authority comes from the new snapshot, not stale settings on that run.

**Implemented:** immutable ready staging, context enforcement and transactional publication.

**Still needed — real acceptance:** exercise these checks against actual AWS/task output and recovered legacy fixtures. A mocked successful execution is not evidence of working raw extraction.

### Process 13 — Initialize and import EG/SG financial layouts

**Trace:** verified staging → [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:169) `prepaid_initialize_layout` → `prepaid_import_layout` at line 198 → regional `layout_rows`. Compare [sp_Prepaid1_EGLayout_Import.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Import.StoredProcedure.sql:8) and [sp_Prepaid1_SGLayout_Import.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Import.StoredProcedure.sql:8). The backend selects source amounts for each layout row; React renders the result rather than calculating the import.

**Purpose:** convert verified sources into reviewable financial statements.

Current functions: `prepaid_initialize_layout`, `prepaid_import_layout`, `prepaid_recompute_layout`, `prepaid_build_outputs`.

Legacy responsibilities replaced here:

| Legacy procedure | Current equivalent |
| --- | --- |
| `sp_Prepaid1_EGLayout`, `sp_Prepaid1_SGLayout` | Regional layout reads; modern GET does not mutate/recompute shared state. |
| `sp_Prepaid1_EGLayout_Import`, `sp_Prepaid1_SGLayout_Import` | Regional source import transaction. |
| `sp_Prepaid1_EGLayout_Import_01_Copa`, `sp_Prepaid1_SGLayout_Import_01_Copa` | COPA/top-up portion of import. |
| `sp_Prepaid1_EGLayout_Import_03_Reclass`, `sp_Prepaid1_SGLayout_Import_03_Reclass` | Import-time destination initialization. |
| `webdcPrepaidSystems_UpdateTopUpSalesFromSourcesUpd`, `webdcPrepaidSystems_SG_UpdateTopUpSalesFromSourcesUpd` | Source import/reclass consolidation. |

The old SG source helper ends with an EG compute call. The modern regional flow does not blindly reproduce that apparent cross-region defect.

Each region has 28 template rows numbered 0–27:

| Rows | Purpose |
| --- | --- |
| 1–3 | Tier 1: revenue before reclass, including GP NBB on the GP MT net column. |
| 4 | Tier 1 total. |
| 7 | Top-up section heading. |
| EG 8–13; SG 8–14 | Tier 2 top-up rows. |
| 15 | Total top-up sales. |
| 18 | Additional revenue (Tier 1 + Tier 2). |
| 21 | Reclass section heading. |
| 22–24 | Tier 4 destinations: GP CM MT, GP CB BB, and EG GP SG BB / SG GP SG MT. |
| 27 | Variance after reclass. |

Current import includes canonical recharge `E/S`, method `PS`, channel `RP`; AMAXCE uses signed `AMAXCEP` adjustments and charges. EG Call Card totals round each source amount to whole units before summing. SG source-month selection still requires a verified producer.

**Still needed — source parity:** compare source view filters/grouping/signs and imported row totals against real legacy outputs. Financial import functions exist; unresolved producer definitions are not fixed by adding duplicate SP wrappers.

### Process 14 — Recompute totals and preserve original-source baselines

**Trace:** imported/edited gross inputs → [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:174) `prepaid_recompute_layout` → net/totals/variance. [legacyRulesMigration.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/legacyRulesMigration.ts:18) captures original source totals; line 32 preserves them when opted in. Legacy conservation formula: [webdcPrepaidSystems_UpdateTier2EditableDataUpd.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_UpdateTier2EditableDataUpd.StoredProcedure.sql:17). Example continuation: the imported draft derives gross/net totals before any user Save.

**Purpose:** make computed cells consistent and support the legacy EG split rule without losing original values.

Legacy compute procedures:

- `sp_Prepaid1_EGLayout_Compute_TopUp`, `sp_Prepaid1_SGLayout_Compute_TopUp`.
- `webdcPrepaidSystems_UpdateNetTopUpSalesUpd`, `webdcPrepaidSystems_SG_UpdateNetTopUpSalesUpd`.
- Legacy per-row/product-category/Tier 1, 2 and 4 gross/net total views are consolidated into the current recompute function.

At the default revision tax rate of `0.12`:

```text
Tier 1 gross = round(net × 1.12, 2)
Tier 2 / Tier 4 net = round(gross / 1.12, 2)
Additional revenue = Tier 1 total + Top-up total
Import-time MT reclass gross = negative of corresponding additional MT gross
Variance = additional revenue + reclass destinations
```

An easy example with all unrelated values zero: COPA net `-100` gives gross `-112`; top-up gross `224` gives net `200`; additional gross is `112`, net `100`. Reclass gross `-112` gives zero gross variance.

Migration 004 also implements the responsibility of `webdcPrepaidSystems_UpdateTier2EditableDataUpd`:

```text
With approved sourceSplitPolicy = legacy_eg_total:
EG row 8/9/10 GP MT gross = original source total − HY MT gross − GP BB gross
```

Original totals are captured immutably per revision/snapshot/row by `prepaid_capture_source_totals` and preserved by `prepaid_preserve_source_totals`. Save updates the derived value and audit in the same transaction. New source data establishes a new baseline; frozen predecessors are never rewritten.

**Implemented but opt-in:** the rule is not missing anymore. Existing/omitted configuration remains `independent`. With the opt-in, EG rows 8–10 expose only HY/BB as editable; the existing UI honors returned `editable_fields`. SG is unchanged.

**Approval needed:** choose/approve the policy and prepare a new snapshot. Do not activate it silently or change historical revisions.

---

## 5. Review, edit and save

**On the screen:** Choose EG Layout or SG Layout. Click Edit, change only permitted gross inputs, then Save. Read-only totals/net values are recalculated by the backend.

**Stage result:** A saved current-source draft, audited changes and rebuilt calculations/outputs. The UI refreshes and shows Edits saved.

**If this stage is blocked:** Reload after a stale-version/source conflict. Unsaved changes require confirmation before switching tabs; a frozen region creates a new draft when Edit is requested.

### Process 15 — Read the regional review layout

**Trace:** UI regional selection → `GET /runs/:runId/layouts/:region` → [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:469) `layout()` → rows, `editable_fields`, validation and `canFreeze`. [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:789) selects EG/SG tabs. Legacy [sp_Prepaid1_EGLayout.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout.StoredProcedure.sql:8) and [sp_Prepaid1_SGLayout.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout.StoredProcedure.sql:9) are the corresponding layout reads.

**Purpose:** show backend-calculated EG and SG data, not demo accounting amounts.

API: `GET /runs/:runId/layouts/:region`, with `region=eg|sg`.

The active snapshot determines what the user reviews. Being preparation-ready means verified sources were published; it does **not** mean financial validation passed or Freeze is permitted.

Computed totals/net cells are not independent user inputs. Render decimals from backend values and use the backend editability metadata. Keep the supplied wireframe tab/button/step structure.

### Process 16 — Save allowed gross inputs and rebuild atomically

**Trace:** [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:529) `saveChanges()` → PATCH with version and changed cells → [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:578) `save()` → SQL Save → optional source-total preservation → output rebuild → refreshed UI. [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:217) implements the SQL whitelist. `prepaid_adjustments` records the change. Legacy [sp_Prepaid1_EGLayout_Save.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Save.StoredProcedure.sql:8) is replaced by this owned, version-checked transaction.

**Purpose:** record accounting adjustments without permitting arbitrary edits to calculated outputs.

API: `PATCH /runs/:runId/layouts/:region`.

```json
{
  "version": 3,
  "changes": [
    { "layoutNumber": 13, "field": "gp_mt_gross", "value": "1250.00" }
  ]
}
```

Allowed fields: `gp_mt_gross`, `hy_mt_gross`, `gp_bb_gross`; values are decimal strings or null. Allowed rows are EG `8,9,10,13,22,23,24` and SG `8,9,12,13,14,22,23,24`, further constrained by the split policy. The server supplies a default reason if absent; no mandatory reason modal is needed.

Save verifies ownership, draft state, revision version and current-source context. It saves/audits/recomputes/rebuilds in one transaction. A stale revision or replaced source must not silently overwrite newer work.

Legacy `sp_Prepaid1_EGLayout_Save` and `sp_Prepaid1_SGLayout_Save` map to this API and `prepaid_save_layout_cells`. Modern edits deliberately restrict calculated columns.

**Still needed — accounting acceptance:** verify exact editable rows and opt-in behavior with actual users/fixtures. There is no known missing Save API or SP.

---

## 6. Allocate, reconcile and construct journal vouchers

**On the screen:** Use Allocation to choose EG/SG and MT/BB, view the summary/breakdown, then use JV to inspect regional journal lines. Correct allowed layout inputs when financial findings require it.

**Stage result:** Allocation/offset/reconciliation/JV records with current validation. These processes run as part of import/Save/build; they are not six extra user buttons.

**If this stage is blocked:** Zero variance alone is insufficient: reference, allocation-basis, rate and journal-balance findings can still prevent Freeze. Backend membership/reconciliation endpoints are not extra UI tabs.

### Process 17 — Expand reference mappings and determine allocation shares

**Trace:** grouped KE24 + allocation mapping + reference → destination basis/denominator/share. [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:243) defines the mapping; line 251 begins `prepaid_build_outputs`; line 271 defines the denominator. Legacy [webPrepaidSystems_FormatC012.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC012.View.sql:8) / [webPrepaidSystems_FormatC013.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC013.View.sql:8) are the grouping/join comparison. In the illustrative example, a combined 60/40 basis produces shares 0.6/0.4.

**Purpose:** distribute reclass amounts over the appropriate profit centers and revenue categories.

Current view chain and `prepaid_build_outputs` consolidate:

| Legacy view group | Purpose |
| --- | --- |
| C000 | Remarks/context. |
| C010, C011 | Source allocation basis and 10-entry destination mapping. |
| C012, C013, C014 | Denominator, source joins and fallback reference mapping. |
| C020, C121 | Destination gross and grouped inputs. |
| C131, C132, C133 | Revenue/posting key, thresholded shares, net amounts and hits. |

Direct mapping outranks expanded fallback mapping; ambiguous mappings are not silently chosen. The legacy `_8` branch applies to GP CB BB and GP SG MT with reference documents beginning with 8. Do not activate a seemingly unused GP SG BB branch without evidence.

Current denominator is the sum by period/revenue type across profit centers. Legacy C012 grouped by period/profit center/revenue type while C013 joined by revenue type only, creating potential multiplication.

**Approval needed, then conditional SP migration:** decide global versus per-profit-center allocation denominator from approved accounting examples. Do not reproduce a known defective join merely to claim identical SQL.

### Process 18 — Calculate allocated amounts, tax and quantities

**Trace:** destination gross × share → reference tax/rate conversion → `prepaid_allocations`. [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:276) calculates `amount2` and `hits2`; compare [webPrepaidSystems_FormatC133.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC133.View.sql:8). [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:400) fetches allocation detail and summary; [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:930) returns the summary used by the table and breakdown.

**Purpose:** produce allocation detail and explain amount/hit totals.

```text
share below 0.00001 → zero (including negative shares)
net amount = round(destination gross × share / (1 + reference tax rate), 2)
hits = round(unrounded allocated net / reference average rate, 0)
```

Missing/zero basis with nonzero gross and invalid reference rates generate validation findings.

In the simple example above, a GP CM basis of 60/40 produces shares 0.6/0.4. Gross 112 at tax 0.12 gives allocated net 60/40; average rate 10 gives 6/4 hits.

Legacy `sp_Prepaid1_Alloc_EG_MT` is replaced by regional MT/BB allocation APIs and summaries. Its exported `SELECT SELECT` syntax defect is not reproduced.

### Process 19 — Build BB/MT offsets and sign-correct posting lines

**Trace:** allocated lines + manual BB destination split → opposite posting side → combined allocation lines. [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:280) creates offsets; compare [webPrepaidSystems_FormatC145.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC145.View.sql:8) and [webPrepaidSystems_FormatC146.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC146.View.sql:8). Offset quantities/precision need the documented accounting decision; they are not a Step Functions calculation.

**Purpose:** create the opposite side of the reclassification.

Legacy C141/C142 compute BB manual split inputs; C145/C146 produce/sum offsets; C151 combines lines and adjusts signs.

Current BB factor is `-manual BB destination gross / regional BB gross`; MT factor is 1. Posting keys are 40/50, with negative amounts sign-flipped and exported amounts absolute.

**Known differences needing accounting approval:**

- Current final offset hits round to whole units. Legacy C145/C146 can retain fractional totals; a 0.5-versus-1 case is documented.
- Current final JV offset amount is rounded to two decimals. Legacy use of `ABS(AMOUNT2)` does not establish the same explicit final rounding.

If approved expectations differ, change the output function in a new migration and add golden fixtures. These are conditional financial SQL changes, not extraction Glue tasks.

### Process 20 — Reconcile and block unsafe freezing

**Trace:** output rebuild → reconciliation rows + findings + JV balance check → `prepaid_validation_results` → `canFreeze`. [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:289) starts reconciliation/variance checks; line 307 checks JV balance. [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:522) exposes eligibility. Validation is automatic on build; backend validation/report endpoints do not imply additional UI panels.

**Purpose:** prove layouts, allocations and journals agree before locking reports.

Legacy reconciliation C010/C020/C030/C040 and four EG/SG × MT/BB horizontal summaries map to revision-owned reconciliation rows. Old horizontal allocation pivots/inner joins can omit profit centers; the new long-form data is not a byte-identical pivot export.

Blocking findings include missing/ambiguous references, zero average rates, missing/zero allocation basis, reconciliation difference, `LAYOUT_VARIANCE` and `JV_NOT_BALANCED`. Source-ready does not bypass them.

Review APIs:

| Method | Path |
| --- | --- |
| GET | `/runs/:runId/layouts/:region/allocations` |
| GET | `/runs/:runId/layouts/:region/allocation-summary` |
| GET | `/runs/:runId/layouts/:region/reconciliation` |
| GET | `/runs/:runId/layouts/:region/reconciliation.csv` |
| GET | `/runs/:runId/layouts/:region/jv` |
| POST | `/runs/:runId/layouts/:region/validate` |

JSON output paging uses limit 1–500 and nonnegative offset, with optional historical `revisionId`. Allocation variant is MT/BB. Automatic rebuilding/validation supports the existing UI; a new validation panel is unnecessary.

### Process 21 — Report legacy reference membership

**Trace:** allocation revenue-type/sub-product pairs → verified source BRAND category → separate membership report. [legacyRulesMigration.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/legacyRulesMigration.ts:51) defines membership views; [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:860) checks completeness. Legacy [tvZTF0455S_validationRptSel.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.tvZTF0455S_validationRptSel.View.sql:8) / [tvZTF0455S_validationV2RptSel.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.tvZTF0455S_validationV2RptSel.View.sql:8). This is a backend report, not a currently visible refined-UI tab or a new automatic Freeze gate.

**Purpose:** identify COPA revenue type/sub-product pairs absent from the legacy prepaid reference category.

Implemented in migration 004:

- `prepaid_reference_membership`, `prepaid_membership_report`, `prepaid_membership_report_v2`.
- `GET /runs/:runId/layouts/:region/reference-membership`.
- `GET /runs/:runId/layouts/:region/reference-membership.csv`.

The legacy check compares revenue type/sub-product against `BRAND = GHP-PREPAID`; it is **not** an account-level mapping check. Offsets with empty revenue type are excluded. V2 uses distinct pairs/costs for GP profit centers excluding BB.

Modes are `all` and `gp-non-bb`. JSON is paginated up to 500 rows; CSV exports all qualifying rows up to 50,000.

Missing/empty `source_brand` means completeness cannot be claimed: JSON returns `complete:false`, reason `REFERENCE_MEMBERSHIP_SOURCE_BRAND_UNVERIFIED` and no purported completed rows; CSV returns 409.

**Implemented, not a new Freeze gate. Still needed — metadata/approval:** include authentic legacy BRAND in producer reference output and approve report interpretation. Do not add unrequested membership controls to the refined screen.

### Process 22 — Format the 40-column journal voucher

**Trace:** finalized allocation/offset lines → [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:295) creates `prepaid_jv_lines` fields → [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:235) defines their 40-column order → [reportService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/reportService.ts:82) serializes frozen JV bytes. Legacy [webPrepaidSystems_JV01.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV01.View.sql:8) defines the business content. The live JV tab reads JSON; History supplies the frozen text file.

**Purpose:** produce the manual SAP execution file from the reviewed financial revision.

Legacy `JV01`, `JV_EGHor`, `JV_SGHor` and `webdcPrepaidSystems_FormatUpd` map to revision-owned JV output construction. Modern code does not DROP/recreate a shared journal table.

Header order is defined in [contracts.ts](../src/modules/prepaid/domain/contracts.ts). Legacy-derived content includes month-end dates `MM/DD/YYYY`, fiscal month, document type SA, company GLOB, PHP, TOP-UP, `MM/YY <region> REVS`, text2 `MM/YY <region> PREPAID REVS` and 10-digit account padding. Lines below absolute amount 0.01 are excluded. Posting key 40/50 totals must balance.

Legacy format/reconciliation wrappers refer to some missing objects, including SG Format B07 and Recon02/03. Their full old pipeline is not established; do not fabricate their definitions or claim exact file parity.

**Approval needed:** confirm header/line contents, field separators, encoding, line endings, posting keys, rounding and manual SAP acceptance using real approved outputs.

---

## 7. Freeze the selected region for manual SAP execution

**On the screen:** With saved, valid data, click Freeze on the selected EG or SG layout. The notification names that region and says it is staged for manual SAP execution.

**Stage result:** An immutable regional revision and immutable formatting settings. EG and SG Freeze independently.

**If this stage is blocked:** Do not claim both regions were frozen or that SAP received/posted the file. The server rechecks versions, source context and validation even if the UI button was enabled.

### Process 23 — Validate, lock and stage an immutable report

**Trace:** [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:550) `freeze()` → regional POST → [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:771) → SQL validation/freeze + `prepaid_frozen_report_formats` + event → `status: staged`. Legacy [sp_Prepaid1_EGLayout_Freeze.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Freeze.StoredProcedure.sql:39) and [sp_Prepaid1_SGLayout_Freeze.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Freeze.StoredProcedure.sql:41) instead trigger P10 jobs. New Freeze deliberately does not call them or a delivery Step Function.

**Purpose:** preserve precisely what the user reviewed and approved.

API: `POST /runs/:runId/layouts/:region/freeze`, with current `version` and optional reason.

Current Freeze validates, rechecks current-source context, freezes **only the selected region**, captures its report format immutably and returns HTTP 200 with `status: staged`. Its database revision state is `frozen`.

It does **not** create a delivery job/slot or automatically post to SAP. UI notifications must say the selected region is staged, not imply both regions froze or that SAP posted it.

Legacy replacements:

| Legacy procedure | Current behavior |
| --- | --- |
| `sp_Prepaid1_EGLayout_Freeze`, `sp_Prepaid1_SGLayout_Freeze` | Regional guarded Freeze, not SQL Agent SAP dispatch. |
| `webdcPrepaidSystems_FreezeLayoutUpd`, `webdcPrepaidSystems_SG_FreezeLayoutUpd` | Immutable regional revision and format capture. |
| `webdcPrepaidSystems_FreezeLayoutUpd_BKP`, `webdcPrepaidSystems_SG_FreezeLayoutUpd_BKP` | Historical only: unconditional/shared-table rebuild backup variants are not current requirements. |

Legacy web Freeze started regional `P10EGOnlyAdHoc`/SG preload jobs; supporting helpers had materialization/control responsibilities. The refined portal stops at manual staging by design.

**Still needed — manual operation/acceptance:** assign who downloads, executes SAP, checks documents and records completion externally. Frozen/staged does not equal SAP-transferred.

---

## 8. Download history and perform manual SAP work

**On the screen:** Open History, filter by upload date and download the frozen report ZIP. An assigned operator executes the JV in SAP outside this workspace.

**Stage result:** Frozen accounting reports, not source files or proof of SAP posting. Actual posting confirmation/duplicate prevention must follow an approved operating procedure.

**If this stage is blocked:** Process 25 explains historical code only. It is not an automatic action between downloading and SAP execution; default delivery remains disabled.

### Process 24 — Preserve and download the frozen reports

**Trace:** [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:434) loads `GET /report-history` → [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:966) → selected snapshot ZIP route → [reportService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/reportService.ts:11) `frozenReports()`. Data is read in a repeatable-read read-only transaction. Legacy [webPrepaidSystems_JV_EGHor.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV_EGHor.View.sql:8) / [webPrepaidSystems_JV_SGHor.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV_SGHor.View.sql:8) correspond to regional JV output content, not the new snapshot ZIP history model.

**Purpose:** allow review/recovery without rewriting old financial decisions.

APIs:

- `GET /report-history`: owned snapshot history; filter `date=YYYY-MM-DD` in Asia/Singapore, default limit 25, maximum 100.
- `GET /runs/:runId/reports/:snapshotFile`: `snapshotFile` is `<snapshotUUID>.zip`.
- `GET /runs/:runId/history`: run audit/event history.

ZIP includes frozen revisions' layout, allocation and reconciliation CSVs plus JV text. It excludes draft calculations, original raw uploads and proof of SAP execution. Membership CSV is a separate backend report, not a silently added historical ZIP member.

Frozen formatting is not regenerated from today's settings. ZIP timestamp is deterministic (1980-01-01). Limits: 50,000 rows/report and 64 MiB combined uncompressed report data.

**Current code:** [reportService.ts](../src/modules/prepaid/application/reportService.ts), repository and frozen-format table.

**Still needed — acceptance:** verify EG/SG partial freezing, history dates, report limits and actual SAP formatting with real data.

### Process 25 — Keep historical delivery compatibility separate

**Trace, historical only:** [worker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/worker.ts:58) `tick(allowLegacyDelivery = false)` excludes default automatic delivery; `deliver()` begins at line 552 and can call `deliveryStateMachine` if explicitly enabled for historical jobs. This is not another user step and not normal Freeze behavior. See senior question 10 before proposing any automatic SAP integration.

**Purpose:** understand old APIs/jobs without accidentally enabling automatic dispatch.

Current worker defaults to skipping legacy delivery work: `allowLegacyDelivery=false`. V1 ingestion and old delivery/export/retry code remain for compatibility, not as the normal refined UI path.

Compatibility delivery concepts include immutable export hashes, execution/receipt identity checks and outcomes delivered/not-delivered/unknown. Unknown outcomes must not be blindly retried. Reversal/replacement is a separately guarded historical operation, not Freeze behavior. Transport/SFTP success alone must not be called SAP-posted success.

Historical exports/jobs APIs:

| Method | Path |
| --- | --- |
| GET | `/runs/:runId/exports` |
| GET | `/runs/:runId/exports/:exportId/download` |
| POST | `/runs/:runId/jobs/:jobId/retry` |
| POST | `/runs/:runId/jobs/:jobId/reconcile` |

**Not required for current manual flow:** deploying automatic delivery/reversal infrastructure. If requested later, it requires explicit SAP adapter, receipt, permissions and operational approval—not simply setting a worker flag.

---

## 9. Edit again or reset for the next preparation

**On the screen:** Choose Edit to review another draft based on current sources, or confirm Reset and return to Upload for a new preparation.

**Stage result:** A new owned working state while prior frozen reports remain recoverable. Reset does not purge S3 or reverse a SAP posting.

**If this stage is blocked:** Pending preparation restricts Reset/source changes. A changed configuration becomes effective through fresh preparation, never by retroactively altering a reviewed frozen file.

### Process 26 — Edit a frozen region without changing history

**Trace:** [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:517) `beginEdit()` checks frozen state → POST Edit when needed → [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:639) `edit()`/`openDraft()` → new draft with predecessor link. The previously frozen revision/report is retained. Legacy [sp_Prepaid1_EGLayout_UnFreeze.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_UnFreeze.StoredProcedure.sql:8) unlocks old shared state; the replacement does not.

**Purpose:** allow another review cycle while retaining the frozen predecessor.

API: `POST /runs/:runId/layouts/:region/edit`, current version and optional reason.

Legacy `sp_Prepaid1_EGLayout_UnFreeze`, `sp_Prepaid1_SGLayout_UnFreeze`, `webdcPrepaidSystems_UnFreezeLayoutUpd` and `webdcPrepaidSystems_SG_UnFreezeLayoutUpd` map to **new draft cloning**, not unlocking/mutating a frozen record.

Original-source totals follow the correct snapshot into the draft. The old frozen revision remains immutable/downloadable. A source change requires current context/new preparation, not a stale clone with new files attached.

**Approval needed:** special legacy unfreeze group policy if the business requires it; current safe clone logic is implemented.

### Process 27 — Reset active work but retain immutable history

**Trace:** confirmation modal → [PrepaidRoute.tsx](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:561) `reset()` sends session and regional versions → [workspaceService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/workspaceService.ts:332) → clear/deactivate active working context → refreshed Upload step. Legacy [sp_Prepaid1_EGLayout_ResetLayout.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_ResetLayout.StoredProcedure.sql:8) and [sp_Prepaid1_SGLayout_ResetLayout.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_ResetLayout.StoredProcedure.sql:8) correspond to regional Reset. Historical reports are retained; no SAP reversal is performed.

**Purpose:** start fresh without erasing previously frozen reports.

APIs:

- `POST /workspace/reset`: owned current session/context Reset.
- `POST /runs/:runId/reset-workspace`: run-based reset support.
- `POST /runs/:runId/layouts/:region/reset`: draft regional reset support.
- `POST /runs/:runId/layouts/:region/import`: controlled draft import support.

Reset validates session/version and applicable run/regional versions. It clears active selection/session/draft inputs and deactivates membership context, while retaining ready/frozen history and S3 objects. It is not physical file deletion or a database purge. Pending preparations cannot be casually reset.

Legacy `sp_Prepaid1_EGLayout_ResetLayout`, `sp_Prepaid1_SGLayout_ResetLayout`, `webdcPrepaidSystems_ResetLayoutUpd` and `webdcPrepaidSystems_SG_ResetLayoutUpd` map to owned draft/active Reset, rather than clearing global shared state.

After Reset, return to Upload, collect all required sources and follow the same flow. Configuration changes or a newly approved source policy become effective through a fresh preparation—not a retroactive edit to frozen data.

---

## 10. Supporting APIs encountered by older clients

The main user journey ends above. The following sections are developer reference: retained compatibility routes, unresolved work, troubleshooting and complete inventories. They do not add screens to the user flow.

These routes are documented here so a developer does not mistake compatibility endpoints for missing UI steps. Do not use them to bypass source-session context.

| Method | Path | Purpose/status |
| --- | --- | --- |
| GET | `/runs` | List owned financial runs. |
| POST | `/runs` | Historical explicit creation; not refined UI. |
| GET | `/runs/:runId` | Read run details. |
| POST | `/runs/:runId/select` | Run selection support. |
| GET | `/runs/:runId/sources` | Read run source information. |
| POST | `/runs/:runId/sources/:code` | Historical run-source upload. |
| DELETE | `/runs/:runId/sources/:code` | Historical run-source removal. |
| POST | `/runs/:runId/upstream` | Historical verified upstream billing attachment. |
| DELETE | `/runs/:runId/upstream` | Historical upstream removal. |
| POST | `/runs/:runId/process` | Historical V1 ingestion. |
| GET | `/state` | Compatibility workspace state alias. |
| GET | `/history` | Compatibility history alias. |
| DELETE | `/uploads` | Compatibility reset/removal alias. |
| POST | `/process` | Compatibility process alias. |
| POST | `/layouts/:region/reset` | Compatibility layout reset alias. |
| POST | `/layouts/:region/import` | Compatibility layout import alias. |
| PATCH | `/layouts/:region/freeze` | Compatibility Freeze alias. |
| POST | `/allocation/validate` | Compatibility validation alias. |
| GET | `/report.csv` | Compatibility report alias. |

Active new-style workspaces reject run-source/Process bypasses with `WORKSPACE_SOURCE_API_REQUIRED`. Historical upstream reuse requires period/workspace/cycle/execution/prefix evidence and exactly adjustment/charge datasets; arbitrary upstream job success is insufficient and must not double-count raw uploads.

**API count:** with the 16 October extraction diagnostic, the router has **50 method/path patterns**: 23 GET, 20 POST, 4 DELETE, 2 PATCH, 1 PUT. A parameterized region counts once, not once per EG/SG; nine are compatibility aliases. Some run-based endpoints are historical-purpose. These counts do not mean every route appears as a UI button.

Route truth: [router.ts](../src/modules/prepaid/api/router.ts) and [openapi.ts](../src/modules/prepaid/api/openapi.ts). Full route visibility in OpenAPI may require `OPENAPI_INCLUDE_NON_ESSENTIAL_ENDPOINTS=true`.

---

## 11. Finish the remaining work in the same flow order

This is the practical development sequence. Do not begin by copying all old procedure names or enabling automatic delivery.

| Order | Work still needed | Type and exact location | Done when |
| --- | --- | --- | --- |
| 1 — recover inputs | Obtain complete extraction job steps/source-view definitions and real report fixtures. | Legacy DB/job investigation; external `sdbTDIR1_Prepaid`/`dgS4HANA_TDIR1` dependencies, not a new API. | Every canonical field/filter/sign/month/cycle is traceable to an approved rule. |
| 2 — extract | Adapt verified Call Card SG, Load API EG/SG and 308 Glue components; recover/implement remaining source families. | Existing source workflows plus new/recovered producer tasks; see AWS verification. | Isolated exact-source extraction, fixed 308 handoff and deterministic records; malformed/mixed-period sources fail. |
| 3 — transform | Implement verified source selection/grouping/rounding and source totals. | Producer transforms; Glue only if selected for actual requirements. | Source totals match approved legacy outputs; no financial SQL duplicated in ETL. |
| 4 — reference | Connect approved ZTF0455S source/refresh and preserve BRAND/WWBRD distinction. | Producer wiring to existing `referenceProvider.ts`/converter plus source access setup. | Approved reference data including authentic membership metadata arrives with provenance. |
| 5 — orchestrate | Deploy Standard V2 state machine and its real tasks, output manifest and failure behavior. | AWS Step Functions + task runtime/IaC in deployment project. | Execution identity and eight datasets pass the portal's actual verification, not mocks. |
| 6 — configure | Set S3/region/runtime role and permissions to Start/Describe executions and access approved objects; configure approved cycles/format. | AWS/IAM/secrets/setup + existing admin `PUT /integration`. | Live test succeeds under least necessary approved access; no placeholders. |
| 7 — approve source split | Decide whether to activate `legacy_eg_total`. | Accounting approval + integration setting + new preparation. Code/migration 004 already exists. | EG original-total conservation is accepted and demonstrated; SG unaffected. |
| 8 — approve arithmetic | Decide denominator scope, fractional offset hits and final amount precision. | Accounting examples; conditional new PostgreSQL migration/output tests. | Approved golden allocation/reconciliation/JV matches intended policy. |
| 9 — approve permissions | Confirm special unfreeze restrictions. | Business/security policy; conditional API/RBAC change. | Authorized Edit behavior matches approved policy without mutating frozen history. |
| 10 — accept end to end | Upload real inputs, prepare, compare EG/SG, save, validate, freeze separately, download and manually execute SAP. | Integration/browser/golden tests + accounting/SAP manual acceptance. | Amounts, quantities, formats, history and operations are signed off. |

Existing membership reports, source-total capture, provider utilities, Save, regional Freeze, Reset and history are **not missing code items**. Their pending source data/activation/acceptance must not be reported as missing APIs.

For Process 4 specifically, the legacy-derived JV content and preparation triggering are already implemented. New evidence-backed readiness metadata/diagnostics were added on 13 October without creating an executable guessed configuration. No additional unconditional SP is identified as necessary by this guide. A new migration is warranted only when evidence proves a financial rule needs changing or a required source rule belongs in PostgreSQL.

---

## 12. Verify the flow while developing

### Start at the failing stage

| Symptom | First checks |
| --- | --- |
| “No access to this workspace” | Authentication, module permissions and ownership; admin status alone does not override ownership. |
| Configuration warning | Integration row, approved actual state-machine name, cycle list and format. Do not invent approved values. |
| Final upload does not prepare | Exact required codes/names/cycle coverage, pending state and whether the worker is running. |
| Preparation fails | Described execution/input, output identity, manifest prefix, source hashes, dataset schema/count/period and SG month. |
| Ready layout cannot Freeze | Financial validation findings; ready is source readiness, not balance approval. |
| Save/Edit returns conflict | Reload revision and current-source context; never suppress version checks. |
| Membership CSV returns 409 | Missing authentic `source_brand`; repair reference producer metadata, not the report with fake data. |
| History omits draft data | Expected: only frozen report material is downloadable as historical ZIP. |
| Freeze does not call SAP | Expected manual-staging design. |

### Code navigation in execution order

1. [integrationReadiness.ts](../src/modules/prepaid/domain/integrationReadiness.ts): legacy setup evidence and configuration diagnostics.
2. [contracts.ts](../src/modules/prepaid/domain/contracts.ts): upload codes, canonical schemas and command validation.
3. [router.ts](../src/modules/prepaid/api/router.ts): authenticated API entry points.
4. [workspaceService.ts](../src/modules/prepaid/application/workspaceService.ts): sessions, uploads, coverage, preparation and Reset.
5. [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts): Standard execution verification and source publication.
6. [referenceProvider.ts](../src/modules/prepaid/application/referenceProvider.ts): verified exported reference reading.
7. [repository.ts](../src/modules/prepaid/infrastructure/repository.ts): persistence, locks, snapshots/revisions.
8. Migration sources in section 1: financial SQL and guards.
9. [runService.ts](../src/modules/prepaid/application/runService.ts): regional reads/Save/Edit/Freeze and outputs.
10. [reportService.ts](../src/modules/prepaid/application/reportService.ts): frozen reports/ZIP.
11. [worker.ts](../src/modules/prepaid/application/worker.ts): background/compatibility work; automatic legacy delivery disabled by default.
12. Frontend files in section 2: presentation and requests.

### Verification evidence and its limits

**14 October walkthrough rewrite:** all 173 file references and referenced line positions were checked; the 49 documented method/path patterns were compared with the instantiated router using dependencies that reject database access/request execution. All 34 legacy SPs are mapped, all 27 process numbers/titles are retained, and internal links were checked. These are documentation/source checks, not accounting acceptance tests. No database migrations, integration-test database, live AWS execution, SAP posting or new browser/pixel acceptance was performed. Earlier test counts below remain historical evidence, not checks rerun for this rewrite.

**13 October revision checks:** backend TypeScript build passed; 26 selected tests passed across readiness (5), reference converter (9), reference provider (4), external contracts (4) and OpenAPI (4). These checks used no portal/RDS database and dispatched no AWS/SAP jobs. The database integration suite was not rerun for this readiness/documentation change.

Earlier recorded checks before the 12 October consolidation (not all rerun on 13 October):

- Backend and frontend builds passed.
- Selected backend tests: 39 integration + 9 converter + 4 provider + 4 contracts + 4 OpenAPI = **60 tests**.
- Frontend: **53 tests**.
- Installed function definitions were checked against migration source.
- Synthetic/mocked fixtures are not a real-source financial parity certificate or AWS/SAP acceptance.
- This is not a claim that the entire unrelated backend suite passes; earlier unrelated authentication/mock failures were outside these selected checks.

Integration tests must use the explicitly approved isolated test database, not the portal/RDS environment connection. Tests create/drop isolated test schemas. Do not point a destructive test lifecycle at `web_portal`.

Useful tests: [prepaid.integration.test.ts](../tests/prepaid.integration.test.ts). Inspect current test/environment prerequisites before running them. Use builds and pure unit tests when an isolated database is unavailable.

### What was consolidated

This is the single primary Prepaid implementation guide and user-flow walkthrough. The companion [questions for the legacy owner](PREPAID_RECLASS_SENIOR_QUESTIONS.md) is a short handoff checklist for unresolved source definitions and decisions, not another implementation guide. Thirteen earlier documents were archived byte-for-byte and checksum-verified before removal. Recover their historical detail from [the original-document archive](archive/prepaid-reclass-docs-before-consolidation-20261012.zip).

Older statements about a period/Create Run UI, automatic Freeze delivery, missing source-total logic or missing membership reporting are superseded by this guide. The archive is historical evidence, not instructions to re-enable those behaviors.

The 12 October consolidation replaced the earlier documents and updated the sample-generator documentation link. The 13 October revision improved read-only readiness diagnostics/OpenAPI with tests. This 14 October rewrite changes documentation only and preserves Processes 1–27. The previous main guide is recoverable from [the pre-walkthrough archive](archive/prepaid-reclass-guide-before-walkthrough-20261014.zip). No application edits, migrations/database writes, AWS/SAP dispatch or UI controls were added.


## 13. Complete technical reference

### Database reference

Migration sources 001–007 define **35 portal Prepaid tables including the migration ledger, 16 functions, 7 views**, plus **5 raw source tables** in a separate schema. Installed objects alone do not establish production ingestion, complete legacy extraction coverage or accounting parity. `prepaid_source_extractions` is new in 006; the 15 October inventory record remains historical evidence for 001–005.

**Current local verification:** migration 007 applied after backup `docs/db-backups/web_portal-before-backend-source-context-007-20261016.dump` (243,159 bytes). All seven IDs and nullable JSONB `context` verified; 38 other Prepaid/raw fingerprints unchanged. No remote migration/extraction. Tests cover native dispatch/recovery, conditional ownership, immutable artifacts, actual XLSX parsing and financial regressions; not real accounting acceptance.

**Historical early-16-October evidence:** migration 006 was applied locally/Aurora. [Earlier deployment evidence](prepaid/aws-verification/2026-10-16-deployment.json) describes portal branches/scripts at that time, not current AWS configuration. Preserve for audit/recovery, not redeployment.

**Backend-only verification results:** TypeScript build passed. All 116 selected Prepaid/Step Functions/OpenAPI tests and 9 Python fixture tests passed, including real local XLSX parsing and disposable-database migrations. The complete TypeScript suite reported 166 passed / 4 failed: the four failures reproduce independently in unchanged `tests/auth.test.ts`, whose legacy-account mock treats the second parameter of the two-parameter identity-link update as an email instead of the user UUID. Authentication code/mocks were not changed in this task. No accepted-file accounting test, live extraction/SAP execution or container image build was performed.

The tables are grouped here in the order their data enters the flow. Every name below has the `prepaid_` prefix:

| Flow role | Tables |
| --- | --- |
| Setup and run identity | `integrations`, `runs`, `workspace_selection` |
| Upload and preparation | `upload_sessions`, `session_files`, `preparation_jobs`, `source_extractions`, `source_files`, `upstream_sources` |
| Verified source publication | `source_snapshots`, `snapshot_context`; `stage_ke24`, `stage_callcard`, `stage_loadup`, `stage_loadapi`, `stage_recharge`, `stage_adjustments`, `stage_charges`, `stage_reference` |
| Layouts and changes | `region_revisions`, `layout_templates`, `layout_rows`, `source_totals`, `adjustments` |
| Financial outputs | `allocations`, `validation_results`, `reconciliation_rows`, `jv_lines` |
| Freeze/history and compatibility jobs | `frozen_report_formats`, `deliveries`, `delivery_slots`, `exports`, `jobs`, `events` |
| Installation tracking | `schema_migrations` |

Existing portal user/workspace tables are reused, not replaced.

**Raw extraction targets** live under `sdbtdir1_prepaid_dbo`, not `web_portal`:

| Workflow | Required raw table(s) | Purpose |
| --- | --- | --- |
| `isg-esatp-dv-prcl_cc_sg-sf` | `dccallcard_sg` (30 columns) | Spreadsheet Call Card SG extraction. |
| `isg-esatp-dv-prcl_la_eg-sf` | `dcload_api` (30 columns) | Spreadsheet Load API EG extraction. |
| `isg-esatp-dv-prcl_la_sg-sf` | `dcload_api_sg` (31 columns) | Spreadsheet Load API SG extraction. |
| `isg-esatp-dv-prcl_308_ba-sf` | `billed_adjustments_header_cycles`, `billed_adjustments_lineitem_cycles` (14 columns each) | 308 cycle headers and adjustment detail rows. |

Migration 005 reproduces the lowercase targets verified in Aurora. The separate existing quoted `"Billed_Adjustments_Header_Cycles"` is **not** the same table: it is left untouched, not renamed, dropped or counted as a required sixth target. Preserve legacy spellings such as `"Luke OR Referece"`, the two spaces in `"INTERNAL  (BASED ON SALES)"`, identity columns and the existing `amount double precision` type. This is compatibility, not approval of a new accounting precision rule.

**Raw tables are not canonical staging.** `prepaid_stage_callcard`, `prepaid_stage_loadapi` and `prepaid_stage_adjustments` continue to store `(snapshot_id, row_number, data jsonb)` with snapshot foreign keys, composite primary keys and ready-snapshot protection. The adapter must still select the exact session inputs, normalize raw rows, produce the eight canonical datasets and attest the V2 manifest before the portal publishes a ready snapshot. Merely creating raw tables does not connect a child Step Function to the UI.

The migration runner uses an advisory transaction lock, applies only missing ledger entries and checks all required tables afterward. Incompatible existing raw columns fail and roll back; migration code does not silently repair/drop/retype a populated producer table. Missing objects after an already-recorded migration are reported as schema drift rather than clearing migration history.

Normal direct PostgreSQL migration: `npm run db:migrate:prepaid:local`. For a specifically approved Aurora target with Data API enabled, set both `PREPAID_MIGRATION_DATA_API_RESOURCE_ARN` and `PREPAID_MIGRATION_DATA_API_SECRET_ARN` **in that process environment**, then run the same command. The database/schema still come from configuration. This is an explicit migration-only transport; the API/worker still use PostgreSQL TCP. It does not open networking, start extractors or change integration approval.

The 16 functions, grouped by when they operate:

| Point in flow | Functions, all prefixed `prepaid_` |
| --- | --- |
| Initialize/import | `assert_draft`, `initialize_layout`, `import_layout` |
| Save/recalculate/reset | `save_layout_cells`, `recompute_layout`, `reset_layout` |
| Keep original source totals | `capture_source_totals`, `preserve_source_totals` |
| Build/freeze/reverse | `build_outputs`, `freeze_layout`, `reversal_lines` |
| Protect persistent state | `guard_frozen_rows`, `guard_ready_staging`, `guard_revision`, `guard_snapshot`, `guard_audit` |

Views: `prepaid_ke24`, `prepaid_reference`, `prepaid_allocation_mapping`, `prepaid_reference_expanded`, `prepaid_reference_membership`, `prepaid_membership_report`, `prepaid_membership_report_v2`.

Direct SQL does not provide all API ownership, version and current-source checks. Do not use these functions directly to bypass the workflow. New financial changes belong in a new reviewed migration, not an edit to installed migration history.

### Legacy procedure responsibility map

The supplied exports contain **20 web procedures + 14 supporting procedures = 34**, of which two are historical backup variants. This table maps responsibilities, not identical procedure names or a claim that every external job is implemented. PostgreSQL deliberately combines financial responsibilities and removes shared/global state mutations.

| Legacy file/object | Current responsibility and process | Status / important difference |
| --- | --- | --- |
| [sp_Prepaid1_Alloc_EG_MT](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_Alloc_EG_MT.StoredProcedure.sql:9) | Regional allocation detail/summary; Processes 17–20 | Implemented; exported legacy SELECT SELECT defect is not copied. |
| [sp_Prepaid1_EGLayout](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout.StoredProcedure.sql:8) | Regional layout GET; Process 15 | Implemented read-only retrieval rather than recomputing on GET. |
| [sp_Prepaid1_EGLayout_Compute_TopUp](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Compute_TopUp.StoredProcedure.sql:8) | prepaid_recompute_layout; Process 14 | Implemented; golden arithmetic acceptance pending. |
| [sp_Prepaid1_EGLayout_Freeze](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Freeze.StoredProcedure.sql:8) | Regional validation + immutable Freeze; Process 23 | Implemented manual staging; automatic P10 dispatch intentionally absent. |
| [sp_Prepaid1_EGLayout_Import](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Import.StoredProcedure.sql:8) | Regional import transaction; Processes 12–14 | Implemented; real source pipeline remains external. |
| [sp_Prepaid1_EGLayout_Import_01_Copa](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Import_01_Copa.StoredProcedure.sql:8) | COPA/top-up portion of prepaid_import_layout; Process 13 | Implemented on canonical sources; original producer rules need verification. |
| [sp_Prepaid1_EGLayout_Import_03_Reclass](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Import_03_Reclass.StoredProcedure.sql:8) | Import-time reclass initialization; Processes 13–14 | Implemented; separate same-named wrapper is unnecessary. |
| [sp_Prepaid1_EGLayout_ResetLayout](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_ResetLayout.StoredProcedure.sql:8) | Owned draft/active workspace Reset; Process 27 | Implemented; frozen reports preserved rather than global clearing. |
| [sp_Prepaid1_EGLayout_Save](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Save.StoredProcedure.sql:8) | Allowed gross cells + audit/rebuild; Process 16 | Implemented; accepted editable policy still needs confirmation. |
| [sp_Prepaid1_EGLayout_UnFreeze](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_UnFreeze.StoredProcedure.sql:8) | Edit → new regional draft; Process 26 | Intentional immutable-history difference; special permissions need confirmation. |
| [sp_Prepaid1_Extract](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_Extract.StoredProcedure.sql:8) | Preparation worker → Standard V2 producer; Processes 8–12 | Caller implemented; real tasks/deployment still external. |
| [sp_Prepaid1_SGLayout](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout.StoredProcedure.sql:9) | Regional layout GET; Process 15 | Implemented read-only retrieval rather than recomputing on GET. |
| [sp_Prepaid1_SGLayout_Compute_TopUp](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Compute_TopUp.StoredProcedure.sql:8) | prepaid_recompute_layout; Process 14 | Implemented; golden arithmetic acceptance pending. |
| [sp_Prepaid1_SGLayout_Freeze](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Freeze.StoredProcedure.sql:8) | Regional validation + immutable Freeze; Process 23 | Implemented manual staging; automatic P10 dispatch intentionally absent. |
| [sp_Prepaid1_SGLayout_Import](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Import.StoredProcedure.sql:8) | Regional import transaction; Processes 12–14 | Implemented; real source pipeline remains external. |
| [sp_Prepaid1_SGLayout_Import_01_Copa](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Import_01_Copa.StoredProcedure.sql:8) | COPA/top-up portion of prepaid_import_layout; Process 13 | Implemented on canonical sources; original producer rules need verification. |
| [sp_Prepaid1_SGLayout_Import_03_Reclass](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Import_03_Reclass.StoredProcedure.sql:8) | Import-time reclass initialization; Processes 13–14 | Implemented; separate same-named wrapper is unnecessary. |
| [sp_Prepaid1_SGLayout_ResetLayout](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_ResetLayout.StoredProcedure.sql:8) | Owned draft/active workspace Reset; Process 27 | Implemented; frozen reports preserved rather than global clearing. |
| [sp_Prepaid1_SGLayout_Save](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Save.StoredProcedure.sql:8) | Allowed gross cells + audit/rebuild; Process 16 | Implemented; accepted editable policy still needs confirmation. |
| [sp_Prepaid1_SGLayout_UnFreeze](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_UnFreeze.StoredProcedure.sql:8) | Edit → new regional draft; Process 26 | Intentional immutable-history difference; special permissions need confirmation. |
| [webdcPrepaidSystems_FormatUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_FormatUpd.StoredProcedure.sql:1) | Revision-owned JV builder; Process 22 | Implemented; no DROP/recreate shared table. |
| [webdcPrepaidSystems_FreezeLayoutUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_FreezeLayoutUpd.StoredProcedure.sql:1) | Regional validation + immutable Freeze; Process 23 | Implemented manual staging; automatic P10 dispatch intentionally absent. |
| [webdcPrepaidSystems_FreezeLayoutUpd_BKP](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_FreezeLayoutUpd_BKP.StoredProcedure.sql:1) | No active backup-variant port required; Process 23 | Historical only; unsafe shared rebuild is not restored. |
| [webdcPrepaidSystems_ResetLayoutUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_ResetLayoutUpd.StoredProcedure.sql:1) | Owned draft/active workspace Reset; Process 27 | Implemented; frozen reports preserved rather than global clearing. |
| [webdcPrepaidSystems_SG_FreezeLayoutUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_SG_FreezeLayoutUpd.StoredProcedure.sql:1) | Regional validation + immutable Freeze; Process 23 | Implemented manual staging; automatic P10 dispatch intentionally absent. |
| [webdcPrepaidSystems_SG_FreezeLayoutUpd_BKP](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_SG_FreezeLayoutUpd_BKP.StoredProcedure.sql:1) | No active backup-variant port required; Process 23 | Historical only; unsafe shared rebuild is not restored. |
| [webdcPrepaidSystems_SG_ResetLayoutUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_SG_ResetLayoutUpd.StoredProcedure.sql:1) | Owned draft/active workspace Reset; Process 27 | Implemented; frozen reports preserved rather than global clearing. |
| [webdcPrepaidSystems_SG_UnFreezeLayoutUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_SG_UnFreezeLayoutUpd.StoredProcedure.sql:1) | Edit → new regional draft; Process 26 | Intentional immutable-history difference; special permissions need confirmation. |
| [webdcPrepaidSystems_SG_UpdateNetTopUpSalesUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_SG_UpdateNetTopUpSalesUpd.StoredProcedure.sql:1) | prepaid_recompute_layout; Process 14 | Implemented; golden arithmetic acceptance pending. |
| [webdcPrepaidSystems_SG_UpdateTopUpSalesFromSourcesUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_SG_UpdateTopUpSalesFromSourcesUpd.StoredProcedure.sql:1) | Regional source import/reclass initialization; Processes 13–14 | Financial code implemented; raw producer parity pending. SG apparent EG call not copied. |
| [webdcPrepaidSystems_UnFreezeLayoutUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_UnFreezeLayoutUpd.StoredProcedure.sql:1) | Edit → new regional draft; Process 26 | Intentional immutable-history difference; special permissions need confirmation. |
| [webdcPrepaidSystems_UpdateNetTopUpSalesUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_UpdateNetTopUpSalesUpd.StoredProcedure.sql:1) | prepaid_recompute_layout; Process 14 | Implemented; golden arithmetic acceptance pending. |
| [webdcPrepaidSystems_UpdateTier2EditableDataUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_UpdateTier2EditableDataUpd.StoredProcedure.sql:13) | Capture/preserve original EG totals; Processes 14, 16 | Implemented opt-in; activation/edit policy needs approval. |
| [webdcPrepaidSystems_UpdateTopUpSalesFromSourcesUpd](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_UpdateTopUpSalesFromSourcesUpd.StoredProcedure.sql:1) | Regional source import/reclass initialization; Processes 13–14 | Financial code implemented; raw producer parity pending. SG apparent EG call not copied. |

### Which responsibilities call Step Functions?

All 34 supplied Prepaid SPs were inspected for the relevant SQL Agent triggers. Three direct job triggers were identified:

| Legacy trigger | Legacy job | Current replacement |
| --- | --- | --- |
| sp_Prepaid1_Extract | Prepaid_Reclass_Preload_P02_Extract_04Mnt | Worker now calls unchanged native children, verifies Glue metadata and creates backend receipts, then calls the complete V2 adapter. Remaining source producers/complete adapter are still to supply; no undocumented job steps were invented. |
| sp_Prepaid1_EGLayout_Freeze | Prepaid_Reclass_Preload_P10_EG_Only_AdHoc | Current EG Freeze stages reports; no automatic delivery execution. |
| sp_Prepaid1_SGLayout_Freeze | Prepaid_Reclass_Preload_P10_SG_Only_AdHoc | Current SG Freeze stages reports; no automatic delivery execution. |

For the current manual-staging flow, **one ingestion state machine** is the required external orchestration. Import, totals, Save, allocation, reconciliation, validation, Edit, Reset and report generation run in the API/PostgreSQL and do not need one Step Function each. Historical V1 ingestion and delivery/reversal callers remain compatibility code, not proof of deployed real producers/SAP tasks.

### API inventory: 50 method/path patterns

All paths below are relative to `/api/workflows/prepaid`. These are backend capabilities, not 50 user actions. Region parameters count once; EG and SG do not double the route count. Required authentication/module access and ownership rules remain applicable; admin configuration is separately restricted. The new `GET /workspace/extractions` is a read-only, owned-session diagnostic, not an extra UI step.

| Group | Method/path patterns |
| --- | --- |
| Setup | GET /readiness; GET /integration; PUT /integration |
| Current workspace | GET /workspace; POST /workspace/sources/:code; DELETE /workspace/sources/:code; POST /workspace/prepare; POST /workspace/reset |
| Frozen report/history | GET /report-history; GET /runs/:runId/reports/:snapshotFile; GET /runs/:runId/history |
| Regional layout commands | GET /runs/:runId/layouts/:region; PATCH /runs/:runId/layouts/:region; POST /runs/:runId/layouts/:region/import; POST /runs/:runId/layouts/:region/reset; POST /runs/:runId/layouts/:region/validate; POST /runs/:runId/layouts/:region/edit; POST /runs/:runId/layouts/:region/freeze; POST /runs/:runId/reset-workspace |
| Outputs | GET /runs/:runId/layouts/:region/allocations; GET /runs/:runId/layouts/:region/allocation-summary; GET /runs/:runId/layouts/:region/reconciliation; GET /runs/:runId/layouts/:region/reconciliation.csv; GET /runs/:runId/layouts/:region/jv; GET /runs/:runId/layouts/:region/reference-membership; GET /runs/:runId/layouts/:region/reference-membership.csv |
| Run/source compatibility support | GET /runs; POST /runs; GET /runs/:runId; POST /runs/:runId/select; GET /runs/:runId/sources; POST /runs/:runId/sources/:code; DELETE /runs/:runId/sources/:code; POST /runs/:runId/upstream; DELETE /runs/:runId/upstream; POST /runs/:runId/process |
| Historical exports/delivery support | GET /runs/:runId/exports; GET /runs/:runId/exports/:exportId/download; POST /runs/:runId/jobs/:jobId/retry; POST /runs/:runId/jobs/:jobId/reconcile |
| Nine compatibility aliases | GET /state; GET /history; DELETE /uploads; POST /process; POST /layouts/:region/reset; POST /layouts/:region/import; PATCH /layouts/:region/freeze; POST /allocation/validate; GET /report.csv |

Totals: **23 GET, 20 POST, 4 DELETE, 2 PATCH, 1 PUT**. Inspect [router.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/api/router.ts:29) and [openapi.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/api/openapi.ts:1) for route/request truth. The new diagnostic is `GET /workspace/extractions`. The module OpenAPI source describes 43 patterns; seven legacy aliases remain router-only. The router is the complete 50-pattern inventory; the general visibility flag does not add those missing alias descriptions. Run-based source/Process APIs must not bypass active upload-session provenance.

### Where to change something safely

| You want to change… | First implementation area | Verification before completion |
| --- | --- | --- |
| Screen/tab/button behavior | PrepaidRoute and existing styles/API helper | Existing component tests and actual browser/wireframe acceptance; no additional unrequested controls. |
| Required input names/record shapes | contracts + workspace requirements + real producer | Valid/invalid names, cycle coverage and canonical fixtures; revise adapter/docs together. |
| Raw selection/filtering | External producer, using recovered source/job specifications | Real input → approved source-total comparison. |
| Tax/total/allocation/rounding rule | New PostgreSQL migration, with service implications if necessary | Approved worked examples and isolated integration/golden tests; do not rewrite installed history. |
| Reference sourcing | Verified provider/converter plus producer wiring | Actual approved export, metadata, duplicates/missing mappings and refresh ownership. |
| Freeze/history behavior | Regional service + immutable guards/report service | Separate-region freezing, stale context, frozen predecessors and stable report bytes. |
| Automatic SAP delivery | Separate explicitly approved operating/integration project | Real receipts, posting confirmation, duplicate prevention and uncertain-outcome handling; current default stays disabled. |

The key developer habit is to trace **the user's action → the exact request → the owning service/worker → the SQL/storage operation → the returned state**. Then compare the matching legacy responsibility and label any gap as missing artifacts, missing external implementation, a deliberate difference or an approval/verification need. Do not call all four “missing SPs.”
