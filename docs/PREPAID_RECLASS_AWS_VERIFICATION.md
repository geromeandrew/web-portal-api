# Provided Prepaid Step Functions: verified placement and remaining gaps

## Current status — backend-only integration, 16 October 2026

**No AWS definitions, Glue jobs/defaults or cloud scripts were edited in this update. No real extraction/SAP execution was started.** Earlier portal-branch deployment records are historical and superseded.

The four native workflows receive only:

```json
{"env_prefix":"isg-esatp-dv"}
```

The backend owns validation, local XLSX normalization, conditional shared-folder coordination, disposable input copies, named dispatch/recovery, Glue-result verification, immutable receipts and canonical-row comparison. `PortalEntry/PortalValidate/PortalExtract`, `portalExtraction` and AWS script overrides are **not required**.

### Live read-only compatibility check

| Workflow | Result |
| --- | --- |
| `isg-esatp-dv-prcl_cc_sg-sf` | Compatible native workflow and Glue input/target mapping. |
| `isg-esatp-dv-prcl_la_eg-sf` | Compatible native workflow and Glue input/target mapping. |
| `isg-esatp-dv-prcl_la_sg-sf` | Compatible native workflow and Glue input/target mapping. |
| `isg-esatp-dv-prcl_308_ba-sf` | **Blocked:** detail requests `$.extract_4_output.JobRunId`; first Glue result exposes `Id`. Owner correction required; not edited here. |

All four are preflighted before dispatch. The 308 defect blocks the sequence safely; portal input cannot fix an internal JSONPath. Run `pnpm verify:prepaid:sources` to recheck read-only. Former `deploy:prepaid:sources -- --apply` rejects deployment before AWS writes.

### Backend configuration (fragment, not a complete integration)

```json
{
  "sourceExtraction": {
    "envPrefix": "isg-esatp-dv",
    "sharedWritesApproved": true
  }
}
```

**Do not copy approval blindly:** unchanged jobs share inbound folders, can move/delete **disposable copies**, and replace/write shared Aurora raw rows through their existing connection—even when the portal DB is local. Financial fragments come independently from verified immutable originals, not unscoped shared rows.

The conditional S3 lock coordinates portal workers across databases. Non-portal/manual producers must coordinate or use isolated infrastructure. Foreign matching files/running jobs block dispatch; originals stay intact; locks are not stolen on timeout. Operators must inspect execution IDs/activity/owned copies before clearing an abandoned lock.

The complete V2 adapter, remaining producers and approved cycles/export settings are still needed. The adapter receives backend-owned `extractionReceipts`, must echo them in its manifest and use their records for covered sources. No child is the complete `ingestStateMachine`.

### Code and runtime prerequisites

- [sourceExtractionWorker.ts](../src/modules/prepaid/application/sourceExtractionWorker.ts): native dispatch/backend receipts.
- [sourceExtraction.ts](../src/modules/prepaid/domain/sourceExtraction.ts): mapping/read-only ASL validation.
- [legacyLanding.ts](../src/modules/prepaid/infrastructure/legacyLanding.ts): conditional lock and owned-copy staging/cleanup.
- [sourceJobInspector.ts](../src/modules/prepaid/infrastructure/sourceJobInspector.ts): read-only Glue settings/activity.
- [sourceNormalizer.ts](../src/modules/prepaid/infrastructure/sourceNormalizer.ts), [normalize_source.py](../infrastructure/prepaid/normalize_source.py): bounded local parsing. Install [requirements-backend.txt](../infrastructure/prepaid/requirements-backend.txt); guide Process 9 covers Windows/Docker.
- [sourceBackendMigration.ts](../src/modules/prepaid/infrastructure/sourceBackendMigration.ts): migration 007, private context; applied **locally only** after backup. 38 other Prepaid/raw fingerprints unchanged. Inventory: 35 portal + 5 raw tables, 16 functions, 7 views.
- Worker IAM: read/execute native workflows; Glue GetJob/GetJobRuns; S3 read/list and conditional lock/copy write/delete plus immutable output writes; KMS if needed. No definition-update permission.

**Remaining owner work:** internal 308 correction, approved/coordinated shared-job operation, accepted files/totals, KE24/period discovery, Call Card EG, Load Up EG/SG, Monthly Recharge, 318 charges, reference refresh and complete V2 output production.

The remainder is **historical inspection/migration evidence**, not current deployment instructions. Current behavior is above and in Processes 8–12 of [the main guide](PREPAID_RECLASS_GUIDE.md).

## Historical inspection and migration evidence

Checked: 15 October 2026, using read-only access to the actual development AWS resources in **us-east-1**. This report is based on state-machine definitions, Glue job settings, inspected S3 scripts and sampled existing executions—not workflow-name guesses.

**Bottom line:** all four exist and belong in **source extraction/preparation, Processes 8–12**. They are useful existing components, but none is the complete V2 ingestion workflow expected by the portal. Do not set any one of them directly as `ingestStateMachine`.

During the original 15 October read-only inspection, no workflow/Glue run, AWS definition change or database write occurred. The later dated migration/deployment sections describe subsequent authorized changes. The inspection copies below remain historical evidence, not deployment sources.

## 1. Exactly where each workflow belongs

All four were ACTIVE and STANDARD when inspected.

| Provided workflow | Confirmed purpose and Glue job | Source role in the portal | Confirmed Aurora target |
| --- | --- | --- | --- |
| `isg-esatp-dv-prcl_cc_sg-sf` | Call Card SG; `isg-esatp-dv-prep_reclass-gljo-extract_1` | `callcard_sg` upload → SG portion of canonical `callcard` after normalization | `sdbtdir1_prepaid_dbo.dccallcard_sg` |
| `isg-esatp-dv-prcl_la_eg-sf` | Load API EG; `…-extract_2` | `load_api_eg` upload → EG portion of canonical `loadapi` | `sdbtdir1_prepaid_dbo.dcload_api` |
| `isg-esatp-dv-prcl_la_sg-sf` | Load API SG; `…-extract_3` | `load_api_sg` upload → SG portion of canonical `loadapi` | `sdbtdir1_prepaid_dbo.dcload_api_sg` |
| `isg-esatp-dv-prcl_308_ba-sf` | 308 adjustments, header then line-item extraction; `…-extract_4` → `…-extract_5` | `308_XX` uploads → canonical `adjustments` after approved header/cycle/line normalization | `sdbtdir1_prepaid_dbo.billed_adjustments_header_cycles` and `…billed_adjustments_lineitem_cycles` |

“LA” here is **Load API**, not Load Up. The definitions, filenames and target tables confirm that distinction.

The target table names/Glue connection were read from AWS settings; no Aurora connection/data inspection was performed. These are not the portal's immutable `prepaid_stage_*` tables.

## 2. What each extractor actually does

The four state machines use the optimized Glue `startJobRun.sync` integration. They wait for Glue and end with its job-run result; they do not perform layout Save/Freeze or SAP delivery.

### Call Card SG

- State: `Extract_1_CC_SG`; definition comment identifies migration from `Prepaid_CallCard_SG.dtsx`.
- Reads `CALLCARD_SG.xlsx`, worksheet `CALLCARD`, skipping four header rows.
- Uses fixed ordinal columns, including `trade` and `INTERNAL (BASED ON SALES)`.
- Filter: `column1 IS NOT NULL AND column1 NOT LIKE 'year%'`.
- Writes the SG Call Card source table, not the final canonical region/kind/month/amount records.

### Load API EG

- State: `Extract_2_LA_EG`; comment identifies `Prepaid_Load_API_EG.dtsx`.
- Reads `LOAD API_EG.xlsx`, skips three header rows and assigns the configured column names.
- Filter: `type IS NOT NULL AND type NOT LIKE 'Type%'`.
- Includes fields such as App ID, Wallet ID, Top up Amount and TOP UP Date. Only approved normalization should turn these raw rows into financial source totals.

### Load API SG

- State: `Extract_3_LA_SG`; comment identifies `Prepaid_Load_API_SG.dtsx`.
- Reads `LOAD API_SG.xlsx`, skips two header rows and uses its configured ordinal columns.
- Filter: `type IS NOT NULL AND type != 'Type'`; configured date format `%d-%b-%Y`.
- Writes the separate SG Load API table. Its rows must be normalized/combined with EG into the canonical `loadapi` dataset.

### 308 Billed Adjustments

- Runs `Extract_4_308_BA` and then `Extract_5_308_BA`; **not parallel**.
- Both use `308. Billed Adjustments Monthly Summary Report_G_B**.xlsx`.
- First job targets the header table and sets `move_to_success=false` so the input remains for the second pass.
- Second job specifies line-item headers: Customer Type/Sub Type, Subscriber Type, Adjustment Type/Code/Reason, Legal Entity, Currency, Amount and Write-Off Activity Indicator.
- Header association, actual billing-cycle identification, period and canonical field/sign rules still need verification. The wildcard helper invents ordinal suffixes for internal filename labels; those suffixes must not be mistaken for the actual billing cycle.

Some 308 Glue descriptions mention Load API SG despite their configured 308 filenames/targets. The placement above follows the definitions and actual arguments/targets, not those inconsistent descriptive labels.

## 3. Confirmed current defect: the 308 chain fails before the second job starts

The two most recent listed executions were FAILED with `States.Runtime`. The latest sampled execution started at **2026-10-15 03:25:05 UTC**.

AWS reported:

> The JSONPath '$.extract_4_output.JobRunId' specified for the field '--previous_job_run_id.$' could not be found.

The [actual first-task execution-history proof](prepaid/aws-verification/2026-10-15/308-task-output-proof.json) confirms that extract_4 SUCCEEDED, its result contains **`Id`**, and it has no **`JobRunId`** property. The second state's parameter looks for the absent property:

```json
{
  "--previous_job_run_id.$": "$.extract_4_output.JobRunId",
  "--previous_job_state.$": "$.extract_4_output.JobRunState"
}
```

Proposed minimal correction to review/test with the AWS owner:

```json
{
  "--previous_job_run_id.$": "$.extract_4_output.Id",
  "--previous_job_state.$": "$.extract_4_output.JobRunState"
}
```

**This correction has not been deployed.** It addresses the observed JSONPath failure, not all possible extraction/data-quality issues.

The two inspected shared scripts do not use `previous_job_run_id`/`previous_job_state` to associate header and detail data. Passing those arguments does not itself implement relational linkage. Confirm whether they should be retained, removed or supported by a separate approved association rule.

Sampled existing executions showed successful completion for Call Card SG and both Load API workflows. That proves those sampled jobs completed; it does not certify source totals, isolation or accounting parity. No new test executions were started.

## 4. Why the portal cannot call these directly as its full ingestion adapter

| Contract area | These child workflows | Portal V2 preparation expects |
| --- | --- | --- |
| Input | Observed execution input `{ "env_prefix": "isg-esatp-dv" }`; state-machine task arguments do not forward uploaded session/source identities. | Session/workspace/preparation IDs, source version, exact source IDs/keys/hashes, expected cycles, bucket and output prefix. |
| Source paths | Configured shared `s3://isg-esatp-rcc-storage-os/prepaid_reclass/inbound/` and fixed names/wildcard. | Owned `prepaid_reclass/sessions/<sessionId>/sources/<sourceId>/<filename>` objects. |
| Task selection | Each covers only its source family. | Complete preparation of eight exact canonical datasets. |
| Output | Final Glue job-run metadata, including `Id`, `JobName` and `JobRunState`. | `{ "contractVersion": 2, "manifestKey": "..." }` plus the attested S3 manifest/datasets. |
| Data publication | Mutable Aurora legacy-shaped source tables. | Immutable source snapshot and canonical staging published by the portal after verification. |
| Period/coverage/provenance | No complete V2 attestation in the inspected definitions. | One KE24 period, exact source hashes and cycle coverage, allowed output keys, row counts and dataset hashes. |

The portal does not add `env_prefix` to its current V2 request. Simply configuring one of these names would therefore fail its input lookup even before the output/schema incompatibilities are resolved.

**Do not** “fix” this by accepting Glue SUCCEEDED as source-ready, disabling checks or pretending a Glue result is a canonical manifest.

## 5. Important side effects and isolation concerns

The inspected job settings use a common Glue connection `isg-esatp-dv-prep_reclass-glco-postgres` and allow two concurrent runs per job.

The shared scripts show:

- [SpreadsheetIngesterWildcard.py](prepaid/aws-verification/2026-10-15/SpreadsheetIngesterWildcard.py.txt:383): with `include_filename` configured—as in all five jobs—DELETE prior target rows by a filename suffix and then append replacement rows. Without that setting the generic script has an overwrite/truncate branch.
- [GlueSpreadsheetWildcard.py](prepaid/aws-verification/2026-10-15/GlueSpreadsheetWildcard.py.txt:176): after processing, copy/move files to a dated success folder; default success behavior deletes the original inbound object unless `move_to_success=false`.
- The failure branch can quarantine inputs to a failed folder and delete their inbound originals.
- The wildcard reader scans matching files in the shared inbound prefix, not the exact persisted portal upload set.

These side effects were **observed in code, not executed by this inspection**.

Do not copy the portal's uploads to that shared folder and run these blindly. Different users, months or concurrent runs can collide by filename, select unintended cycles and replace shared source rows. A correct adapter must provide source/run isolation and exact-source selection, preserving the portal's immutable originals and reviewed snapshot provenance.

## 6. Correct placement in the complete flow

```text
Portal: upload all required sources
  → Preparation worker calls ONE complete V2 parent ingestion workflow
      → Validate/bind the exact session's source identities
      → Invoke isolated source-specific tasks/workflows
          Call Card SG child
          Load API EG child
          Load API SG child
          308 header → detail child (after its defect is resolved)
          Remaining required source families
      → Normalize source/reference records
      → Produce 8 checksummed canonical JSONL datasets + V2 manifest
      → Return { contractVersion: 2, manifestKey }
  → Portal verifies execution, sources, period, coverage and dataset evidence
  → Publish immutable snapshot → import EG/SG → Edit/Save → validate
  → Freeze selected region → History/download → manual SAP execution
```

The parent is a recommended integration boundary, **not an existing deployed resource discovered in this check**. It can reuse these components only after their path/data isolation and outputs are adapted. A wrapper alone does not make shared mutable extraction safe.

These four have **no placement under Save, Freeze or SAP delivery**. They partially replace extraction work behind legacy `sp_Prepaid1_Extract` / `Prepaid_Reclass_Preload_P02_Extract_04Mnt`. Their comments identify some migrated SSIS packages, but do not prove that the entire old extraction job was reproduced.

## 7. Historical gap list from 15 October — use the 16 October status above

1. **Fix and verify the 308 state handoff:** review the `Id` lookup and confirm how header/detail rows are associated. AWS definition change requires an explicitly approved deployment.
2. **Isolate source paths and target data:** exact uploaded objects, actual cycles and run-specific intermediate data; no destructive mutation of the portal's immutable sources. Do not enable concurrent per-user use of the shared current configuration.
3. **Confirm remaining source coverage:** these four do not establish KE24, Call Card EG, Load Up EG/SG, monthly Recharge, 318 charges or approved reference refresh. Those may exist elsewhere; they were not supplied/verified in this inspection.
4. **Implement the canonical bridge:** normalize the legacy-shaped extracted data into the portal's `ke24, callcard, loadup, loadapi, recharge, adjustments, charges, reference` schemas. Verify source totals, field mapping, period/month selection and billing cycles.
5. **Build/deploy the complete V2 parent:** propagate identity/provenance, wait for all required work, fail on incomplete preparation, publish the eight datasets and manifest. No fake empty required sources or guessed approval values.
6. **Configure the portal only after compatibility exists:** point `ingestStateMachine` at that verified complete workflow, not one child. Supply approved cycles/format separately.
7. **Perform accepted-data tests:** source hashes, isolation/concurrency, actual totals, period/cycle coverage, failure/retry and full EG/SG report parity. Existing successful Glue runs are not a substitute.

The earlier statement “the actual extraction implementation is missing” must now be read more precisely: **four source-specific AWS extractors and their shared parsing scripts exist; a complete portal-compatible, isolated ingestion pipeline is still not established.** Do not recreate these four from scratch without first assessing reuse.

## 8. Evidence and current code

### Inspected AWS copies

These are local inspection copies, not the files used to deploy AWS. Script copies have sensitive-looking literal values redacted if present; metadata records source S3 locations, ETags and modification dates.

- [Inspection metadata, job defaults and sampled outcomes](prepaid/aws-verification/2026-10-15/inspection.json).
- [Call Card SG definition](prepaid/aws-verification/2026-10-15/isg-esatp-dv-prcl_cc_sg-sf.asl.json).
- [Load API EG definition](prepaid/aws-verification/2026-10-15/isg-esatp-dv-prcl_la_eg-sf.asl.json).
- [Load API SG definition](prepaid/aws-verification/2026-10-15/isg-esatp-dv-prcl_la_sg-sf.asl.json).
- [308 current definition, including observed faulty lookup](prepaid/aws-verification/2026-10-15/isg-esatp-dv-prcl_308_ba-sf.asl.json).
- [Shared Glue entry script](prepaid/aws-verification/2026-10-15/GlueSpreadsheetWildcard.py.txt).
- [Shared spreadsheet ingester](prepaid/aws-verification/2026-10-15/SpreadsheetIngesterWildcard.py.txt).

### Portal integration points

- [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts): `tick()`, persisted `execution_input`, `startExecution()`, exact manifest/dataset verification.
- [contracts.ts](../src/modules/prepaid/domain/contracts.ts): `sourceCodes`, `datasetSchemas`, `manualIntegrationSchema`, `sessionManifestSchema`.
- [prepaidStorage.ts](../src/modules/prepaid/infrastructure/prepaidStorage.ts): `sessionPrefix()`, key restrictions, row-count/checksum verification.
- [workspaceService.ts](../src/modules/prepaid/application/workspaceService.ts): required uploads, `enqueue()` and owned sessions.
- [Main walkthrough](PREPAID_RECLASS_GUIDE.md): Processes 8–12 for preparation; 23–25 are Freeze/history/manual delivery, not these extractors.
- [Senior questions](PREPAID_RECLASS_SENIOR_QUESTIONS.md): ask now for remaining source jobs, safe adaptation, 308 correction and verified canonical results—not an assumption that no Glue extraction code exists.

## 9. Database migration follow-up — 15 October 2026

The active portal `.env` and the Glue connection resolve to the same Aurora cluster, database `postgres`. Before this follow-up, its `web_portal` schema had the general portal objects but **no portal `prepaid_*` tables, functions or migration ledger**. All five raw extraction targets already existed in `sdbtdir1_prepaid_dbo`.

Prepaid migrations **001–005 were applied successfully to Aurora**, after an available cluster backup snapshot. Migration **005 was also applied to the saved local PostgreSQL portal database**, after a custom-format backup. Both now have **34 portal Prepaid tables + 5 required raw targets, 16 portal functions and 7 portal views**, and repeat migration runs apply nothing.

New [rawSourceMigration.ts](../src/modules/prepaid/infrastructure/rawSourceMigration.ts) codifies the five verified raw layouts. Existing case/spaces/spelling, nullable fields, identity columns, `amount double precision` and the adjustment-line unique index are retained. The separate existing quoted `"Billed_Adjustments_Header_Cycles"` remains untouched. Aurora before/after checks found unchanged data fingerprints for all 25 existing portal tables and six relevant raw tables, and unchanged raw column definitions.

See [the complete guide, Process 2](PREPAID_RECLASS_GUIDE.md) for backups, migration transport, test results and runtime connectivity caveats, and [the verification evidence](prepaid/migration-verification/2026-10-15-aurora.json) for object names and fingerprints.

This completes the **known table prerequisites** for the implemented backend and these four workflows. It does not deploy/fix the 308 state machine, build canonical transformations, isolate shared raw writes, approve integrations or execute extraction/SAP jobs. The raw-to-canonical bridge and missing source-family coverage described above remain necessary.
