# Prepaid Re-Class: questions for the legacy owner

Updated 19 October 2026 for native SQL Server restoration, XLSX output and ten-source backend integration.

**Reference update (19 October):** item 4 no longer asks someone to build a missing producer. The existing `isg-esatp-dv-sap_to_pg-gljo-ztf0455s` Glue job was found and backend refresh/export/recovery is now implemented. What remains is authorization to operate its full-table overwrite, real SAP records, client/company/as-of-policy approval and a named owner. Install/deploy additive migration 009 before using the admin operation; no live job or sandbox migration was run in this implementation change.

**19 October native restore:** etl_db_web.bak has now been restored and checked in native SQL Server LocalDB, without virtualization. Its 20 Prepaid procedures and 11 views match the supplied web SQL definitions; the seven configured filenames in item 2 are confirmed. The missing accounting records/job settings belong to other databases. [Restore and fixes](PREPAID_RECLASS_AWS_VERIFICATION.md#native-sql-server-restore-and-confirmed-fixes---19-october-2026) records the evidence. The 4.5 MB implementation gap is addressed across API/worker/landing/parsers with a 100 MiB ceiling and retained safety bounds; do not ask the senior to invent the already visible legacy upload limit. The user confirmed XLSX; item 9 now asks for workbook acceptance, not text delimiters.

All ten supplied source workflows/twelve Glue jobs are now inspected and integrated without editing AWS definitions. Their native input is only env_prefix; validation, normalization, coordination and receipts are backend-owned. The old 308 handoff defect has been corrected externally and is no longer outstanding.

A final V2 Step Function is not required in native_sources mode: nativeManifestBuilder combines ten verified original-derived source receipts with an approved immutable SAP reference export. Existing external adapters remain optional. No integration rows/approvals were auto-enabled; no live extraction/SAP jobs were started.

Still ask for shared-job coordination approval, real reference export/refresh owner, actual cycles, accepted XLSX template/cell requirements and accounting fixtures. Do not ask for the six now-supplied extractors, a 308 fix, or an unknown manual-report file type. See [current integration guide](PREPAID_RECLASS_AWS_VERIFICATION.md).

## Message you can send first

> The new portal already has upload tracking, EG/SG calculations, editing, allocation, validation, Freeze and report downloads. What I still need is the actual legacy extraction/export setup and confirmation of a few accounting rules. Could you help me with the questions below? I have linked each question to the part of the workflow it affects.

The order below follows the user flow:

**Upload → prepare sources → review/edit → allocate/validate → Freeze → download/SAP → start again.**

## Are all these items missing from the legacy?

**No. These are 12 questions, not 12 unimplemented features.** Some request missing files/data, some confirm rules already visible in the legacy, and some ask for evidence that the new implementation is correct.

| Type | What it means | Why we still ask |
| --- | --- | --- |
| Missing artifact/data | Referenced by legacy code, but not included in the supplied source/SQL export. | A procedure can name a SQL Agent job without containing its steps. A table definition describes columns, not the actual cycle or mapping records. |
| Decision about known behavior | Legacy behavior is visible, but the current behavior differs, is optional or may avoid an apparent defect. | Confirm the intended accounting or permission rule before activating/changing it. This is not automatically a missing SP. |
| Verification | The current functionality exists, but real accepted inputs/outputs are still needed. | Passing synthetic tests does not prove that real source totals or SAP files match the accepted legacy results. |
| New-system decision/setup | Concerns the new architecture or refined workflow, not missing legacy code. | AWS settings cannot be inferred from SQL Server jobs. Manual SAP execution is a deliberate change from automatic legacy delivery. |

**“Not provided” means not found in the supplied files—not necessarily absent from the original running legacy system.** The missing dependencies may exist separately in SQL Agent, other databases, configuration or production data. Ask your senior where to recover them; do not assume they must all be rebuilt from scratch.

Each question below states its type. Several combine a missing artifact with confirmation or verification.

### Using the code references

Each item now has a **Where to look in the code** block. Links point to the local file and, where useful, its current line number. If your editor does not jump to the line, open the named file and search for the function/SQL object shown beside it. Line numbers may change after edits.

Current PostgreSQL functions/views are defined inside the TypeScript migration files—not separate SQL Server-style SP files. Read those definitions; do not rerun migrations just to inspect them. Legacy SQL links point to the supplied Downloads export. Referenced job names are not job-step files.

The absolute links use this machine's paths. If sharing this document, your senior can use the visible filenames and object names to find the equivalent files in their copy.

## 1. Can we approve and verify how source preparation now runs?

**Type: recovered source implementation + operational approval/real-file verification.** The original SQL Agent trigger is visible; ten migrated AWS extractors and their parsers are now supplied. Backend final assembly is implemented.

- **Ask:** “Can we approve these ten source workflows using the shared inbound/raw tables? Who coordinates manual/external starts? Can you give us one accepted month's files and legacy totals to verify all column mappings, periods, signs and rounding? Does the old 04Mnt name imply an extra selection window we must reproduce?”
- **Legacy:** sp_Prepaid1_Extract → Prepaid_Reclass_Preload_P02_Extract_04Mnt; EG/SG Import_01_Copa consume source aggregates. The original job-step chain is not inside its trigger SP.
- **Now / process:** Processes **8–12**. sourceExtractionWorker preflights ten machines, verifies immutable originals, normalizes locally, stages owned disposable copies, calls native jobs sequentially, verifies Glue results and writes receipts. nativeManifestBuilder adds the approved reference, emits eight datasets and publishes through existing transactional calculations.
- **Need:** approved operating coordination, accepted real fixtures/totals and clarification of undocumented window rules. Not six new extractors, a 308 correction, portal validator states or a new final adapter.

**Why this matters:** unchanged Glue writes shared Aurora raw data and moves/deletes disposable copies. The backend lock protects cooperating portal workers, not arbitrary external starts. Financial evidence comes independently from original uploads; Glue success is not proof those shared rows equal the session's canonical rows. Agree this boundary and the ownership before enabling sharedWritesApproved.

**Concrete handoff:** accepted files/expected outputs for one period, actual required cycles, reference refresh/export ownership, external-job coordination schedule and recovery procedure. Supply original ordered SQL Agent steps only for any selection behavior not established by the supplied workflows; do not infer a four-month rule from the name.

### Where to look in the code

- **Legacy trigger:** [sp_Prepaid1_Extract.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_Extract.StoredProcedure.sql:39) — sp_start_job, not job implementation.
- **Current entry:** [workspaceService.ts](../src/modules/prepaid/application/workspaceService.ts), enqueue(); [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts), tick().
- **Ten-machine mapping:** [sourceExtraction.ts](../src/modules/prepaid/domain/sourceExtraction.ts), sourceWorkflows; [sourceExtractionWorker.ts](../src/modules/prepaid/application/sourceExtractionWorker.ts), advance().
- **Parsing and final assembly:** [normalize_source.py](../infrastructure/prepaid/normalize_source.py), normalize()/source parsers; [nativeManifestBuilder.ts](../src/modules/prepaid/application/nativeManifestBuilder.ts), build().
- **AWS boundary:** [stepFunctionsRunner.ts](../src/stepFunctionsRunner.ts), startExecution()/describeExecution(); [sourceJobInspector.ts](../src/modules/prepaid/infrastructure/sourceJobInspector.ts), verify()/idle(). No definition updates.
- **Evidence and setup:** [AWS integration guide](PREPAID_RECLASS_AWS_VERIFICATION.md) — exact filenames/jobs/tables, native settings and acceptance limitations.

## 2. Which files and billing cycles are really required, and how is the month chosen?

**Recovered since the earlier review:** the backup's Prepaid group has KE24.xlsx, EG CALLCARD.xlsx, SG CALLCARD.xlsx, LOAD API_EG.xlsx, LOAD API_SG.xlsx, LOAD UP_EG.xlsx and LOAD UP_SG.xlsx. These are historical upload-configuration rows, not proof of the full extraction dependency list. Do not ask which names those rows contain; ask how Recharge/308/318 entered the original pipeline and which reports/cycles are required for one real month. Current supplied AWS Call Card names differ, so retain the verified current contract until any aliases are deliberately implemented/tested.

**Cycle evidence limit:** the supplied AllBillCycles definitions contain no values, and no direct Prepaid use of those two tables was found. The portal currently requires both 308 and 318 for every expected cycle. Ask whether that paired coverage is intended; do not present it as a confirmed legacy rule.

**Type: missing data/specification + confirmation.** Source references and some month rules exist; actual cycle values and the complete raw-file contract still need evidence.

- **Ask:** “What is the complete required file list? Which billing cycles must be included? How do we choose the accounting period and the correct SG Call Card month? Are 411 and `sap_glbilled.txt` actually used for this workflow?”
- **Legacy:** KE24/source tables; `zPARAM_ICCBS_AllBillCycles` / `dczPARAM_ICCBS_AllBillCycles`; SG Call Card source views. The supplied cycle-table definitions contain no actual cycle values.
- **Now / process:** Processes **4, 6, 9, 11**. `contracts.ts` expects eight base uploads plus 308/318 for each configured cycle. Period comes from KE24; 411 and `sap_glbilled.txt` have no upload code.
- **Need:** approved filenames, sample layouts/column mappings, cycle values and month-selection rules. Parsing for all ten workflows is implemented; this now unblocks **configuration and real-file acceptance**. Do not guess cycles or truncate legacy three-character cycle values into the current two-digit contract.

**Why this matters:** the portal cannot know that uploads are complete unless the required files and cycles are correct. Choosing the wrong period or SG source month can produce apparently valid calculations using the wrong data.

**Request a concrete handoff:** a file list for one real month, including worksheet/header locations and the expected period/cycle values. Ask what happens if a file is empty, missing, duplicated or contains several months. For SG Call Card, ask whether “latest month” means the latest available month or the selected accounting month. This confirms the upload contract and the producer's selection rules.

### Where to look in the code

- **Legacy cycles:** [dbo.zPARAM_ICCBS_AllBillCycles.Table.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.zPARAM_ICCBS_AllBillCycles.Table.sql:10) and [dbo.dczPARAM_ICCBS_AllBillCycles.Table.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.dczPARAM_ICCBS_AllBillCycles.Table.sql:10) — inspect `zBillMonth`, `zBillRunDate` and `zBillCycle`. These are definitions, not cycle-data exports.
- **Current file contract:** [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:13) — `sourceCodes`/`sourceNames`; `expectedName()` begins at line 41. The integration's `expectedCycles` is in the same file under `integrationSchema`.
- **Current coverage/period checks:** [workspaceService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/workspaceService.ts:20) — `required()` constructs the complete upload list; [preparationWorker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/preparationWorker.ts:167) — cycle coverage; line 308 begins row-period and Call Card month handling.
- **Existing test:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1042) — exact names, ownership and required cycles. This is a test of the current contract, not proof of the real legacy file list.

## 3. Which records should be included, excluded or adjusted before calculating totals?

**Type: missing underlying source definitions + verification.** Some filters/calculations are visible and implemented; this asks for the remaining producer rules and examples, not a rewrite of every existing rule.

- **Ask:** “For each source, which rows count? What filters, signs, grouping and rounding were applied before the EG/SG totals were imported?”
- **Legacy:** `webdcKE24_EC_COPAValues`, Call Card/Load Up/Load API total views, `WebRechargeSumamry_*` and `WebAmaxee_*` source views. Some underlying source definitions are outside the supplied exports.
- **Now / process:** Processes **9, 13–14**. The PostgreSQL import functions exist, but they depend on correctly prepared input. The external producer must supply those records.
- **Need:** exact source rules and a worked example per source. This unblocks **transform code and source-total tests**, not a duplicate of the financial SPs.

**Why this matters:** two implementations can read the same file and produce different totals if they select different rows or handle negatives/rounding differently. The financial calculations may be correct while their starting data is wrong.

**Request a concrete handoff:** for each source, show which raw rows become which layout total. Ask about excluded customer categories, adjustments/reversals, negative amounts, duplicate rows and the order of rounding/grouping. Request one small worked example showing raw amounts, applied rules and the final total. Use it as a producer test rather than asking for every financial SP to be rewritten.

### Where to look in the code

- **Legacy import consumers:** [dbo.sp_Prepaid1_EGLayout_Import_01_Copa.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Import_01_Copa.StoredProcedure.sql:8) and [dbo.sp_Prepaid1_SGLayout_Import_01_Copa.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Import_01_Copa.StoredProcedure.sql:8) — follow the referenced source views/tables to find where the original source totals came from.
- **Current normalized inputs:** [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:50) — `datasetSchemas` defines the records the producer must supply.
- **Current financial import:** [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:198) — `prepaid_import_layout`; lines 207 onward contain COPA, Load Up/API, Recharge, AMAXCE and Call Card import expressions.
- **Existing tests:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1059) — AMAXCE/recharge and allocation conservation; [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1362) — SG trade/internal Call Card and signed AMAXCE. The missing raw-source transformations are upstream of these tests/functions.

## 4. Where should the real SAP mapping come from, and how often is it refreshed?

**Type: live operation/data approval + ownership confirmation.** The existing SAP-to-PostgreSQL reference job has now been found and its portal refresh/export integration is implemented. It is not another missing Step Function.

- **Ask:** “Who owns the ZTF0455S mapping, and how can we obtain an approved export? Are client 300 and company GLOB the correct filters? Should we retain both BRAND and WWBRD, and what does each mean?”
- **Legacy:** `dgS4HANA_TDIR1.dbo.ZTF0455S`. `WWBRD` is used as the allocation brand; `BRAND` is a separate category used for prepaid membership checks.
- **Now / process:** Processes **4, 10 and 21**. Existing Glue job `isg-esatp-dv-sap_to_pg-gljo-ztf0455s` reads SAPPRD.ZTF0455S and overwrites `dgs4hana_tdir1_dbo.ztf0455s`. New admin `/reference-exports` APIs/worker verify, refresh when explicitly authorized, export immutable original-field JSONL and retain provenance. The existing provider/native builder use the approved descriptor. No UI or Step Function is changed.
- **Need:** authorize the whole-table overwrite and shared-job coordination, obtain real data, confirm client 300/company GLOB and BRAND/WWBRD meanings, name the owner and approve the refresh/as-of-period policy. This unblocks **operational activation and acceptance**, not another source integration implementation.

**Why this matters:** the mapping supplies accounts, classification fields, tax rates, average rates and units used in allocation. A copied or outdated mapping can change the journal even when the uploaded revenue is unchanged. BRAND and WWBRD must not be merged simply because their names are similar.

**Request a concrete handoff:** who may authorize/run the existing overwrite job, when it may run, who checks its result and who approves mapping changes. Ask whether historical periods use the mapping available at that time or the latest mapping. Confirm client 300/GLOB and duplicate/missing-mapping handling. The inspected job has no WHERE filter and overwrites the full shared table; portal export later selects only its acknowledged scope. No retained run history/trigger was returned, which is not proof there is no external scheduler. We still need an approved live execution/export and data owner, not invented seed rows. `export_existing` does not prove freshness; technical completion does not equal accounting approval.

### Where to look in the code

- **Legacy reference views:** [dbo.ZTF0455S.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.ZTF0455S.View.sql:10) — reads the external table and filters client `300`; [dbo.ZTF0455S_with_revtype.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.ZTF0455S_with_revtype.View.sql:8) — reference revenue-type derivation.
- **Current conversion:** [referenceConverter.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/referenceConverter.ts:7) — `convertLegacyReference()`; inspect `MANDT`, `BUKRS`, `BRAND`, `WWBRD`, `TAXRATE` and `AVERATE`. Line 49 retains `BRAND` as `source_brand`.
- **Current reading/tools:** [referenceProvider.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/referenceProvider.ts:23) — `load()` verifies an export; [convertPrepaidReference.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/convertPrepaidReference.ts:1) — offline converter entry point, not a live refresh job.
- **Current refresh/export:** [referenceRefreshService.ts](../src/modules/prepaid/application/referenceRefreshService.ts), [referenceRefreshWorker.ts](../src/modules/prepaid/application/referenceRefreshWorker.ts), [referenceRefreshRunner.ts](../src/modules/prepaid/infrastructure/referenceRefreshRunner.ts), [referenceSource.ts](../src/modules/prepaid/infrastructure/referenceSource.ts). Migration 009 adds only operation tracking; existing shared SAP rows are not seeded or overwritten by migration.
- **Tests:** [prepaid.referenceRefresh.awsHttp.test.ts](../tests/prepaid.referenceRefresh.awsHttp.test.ts) uses real SDK clients over loopback; [prepaid.referenceRefresh.integration.test.ts](../tests/prepaid.referenceRefresh.integration.test.ts) checks isolated PostgreSQL/admin HTTP, empty-data rejection, lost-dispatch recovery and immutable retry bytes. [prepaid.reference.test.ts](../tests/prepaid.reference.test.ts) retains field/provenance checks. None is a live SAP accounting acceptance run.

## 5. Must EG top-up edits always preserve the original source total?

**Type: decision about known legacy behavior.** The legacy formula is provided and its modern equivalent is implemented. The question is whether to activate it and confirm edit permissions.

- **Ask:** “For EG Call Card, Load Up and Load API, should GP MT always equal the original total minus HY MT minus GP BB? Which cells should users actually be allowed to edit in EG and SG?”
- **Legacy:** `webdcPrepaidSystems_UpdateTier2EditableDataUpd`, regional Save procedures and editable-control views.
- **Now / process:** Processes **14 and 16**. Original-total capture and the `legacy_eg_total` policy are implemented. The policy is opt-in; the default still permits independent allowed gross edits.
- **Need:** **accounting decision**, not a missing SP. If approved, configure the policy and prepare new source data. Confirm allowed cells; do not change frozen history.

**Why this matters:** preserving the original total lets users redistribute a source amount without creating or removing revenue. For example, with an original total of 1,000, HY of 200 and BB of 100, the conservation rule derives GP MT as 700. Independent editing does not enforce that same relationship.

**Decision to record:** should that conservation rule always apply to EG rows 8–10, or are there approved exceptions? Ask for the permitted EG/SG cells and whether blank means zero or “not supplied.” If the implemented policy is approved, activate it for a fresh preparation; otherwise document the approved independent-edit behavior. This is primarily a policy choice, not missing formula code.

### Where to look in the code

- **Legacy formula:** [dbo.webdcPrepaidSystems_UpdateTier2EditableDataUpd.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystems_UpdateTier2EditableDataUpd.StoredProcedure.sql:17) — the original total minus HY/BB expression. See also [dbo.sp_Prepaid1_EGLayout_Save.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Save.StoredProcedure.sql:8) and [dbo.sp_Prepaid1_SGLayout_Save.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Save.StoredProcedure.sql:8) for regional Save behavior.
- **Current conservation functions:** [legacyRulesMigration.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/legacyRulesMigration.ts:18) — `prepaid_capture_source_totals`; `prepaid_preserve_source_totals` follows below. Search for `legacy_eg_total` and `original_gross`.
- **Current policy/editability:** [contracts.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/contracts.ts:193) — `sourceSplitPolicy`; [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:469) — `layout()` returns `editable_fields`; `save()` begins at line 578 and calls preservation at line 622.
- **Existing test:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1537) — opt-in conservation, audit and immutable original totals. The UI consumes the editability policy; it does not define the accounting formula.

## 6. Should allocation be based on all profit centers together or each separately?

**Type: decision about a known calculation difference.** The legacy SQL is available; expected accounting results are needed to distinguish an intended rule from an apparent join defect.

- **Ask:** “When calculating an allocation percentage, what total should we divide by: the revenue-type total across all profit centers, or a separate total for each profit center? Can you show one correct example?”
- **Legacy:** `webPrepaidSystems_FormatC012` and `webPrepaidSystems_FormatC013`; their grouping/join combination can multiply records.
- **Now / process:** Process **17**. `prepaid_build_outputs` currently uses the total by period/revenue type across profit centers.
- **Need:** **accounting decision plus expected numbers**. If the intended rule differs, change the PostgreSQL calculation in a new migration and test it. Do not copy an apparent legacy join defect blindly.

**Why this matters:** the denominator controls how much revenue each profit center receives. A different grouping can change every allocated amount. The legacy grouping/join combination needs to be checked against intended results, not assumed correct merely because it exists.

**Decision to record:** ask for a small example with the same revenue type in two profit centers—for example basis amounts 60 and 40—and the expected shares and allocated amounts. Confirm whether the intended shares are 60%/40% across the combined total or follow another rule. Use the agreed result to decide whether the current PostgreSQL denominator should stay or change.

### Where to look in the code

- **Legacy denominator/join:** [dbo.webPrepaidSystems_FormatC012.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC012.View.sql:8) — `GROUP BY` includes profit center; [dbo.webPrepaidSystems_FormatC013.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC013.View.sql:8) — inspect which fields the join actually uses.
- **Current denominator:** [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:271) — `denominators` inside `prepaid_build_outputs`, specifically `sum(amount) OVER(PARTITION BY period,revenue_type)`.
- **Current allocation result/API:** [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:809) — `output()`; `allocationSummary()` begins at line 930.
- **Existing test:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1059) — cross-profit-center allocation conservation. A senior/accounting-approved example is still needed to certify the intended denominator.

## 7. How should fractional quantities and final amounts be rounded?

**Type: decision about a known calculation difference.** Both implementations have calculation code. The question is which precision/rounding behavior accounting accepts.

- **Ask:** “Can an offset quantity remain fractional, such as 0.5, or must it become a whole number? At what stage should money be rounded to two decimals?”
- **Legacy:** `webPrepaidSystems_FormatC133`, `FormatC145`, `FormatC146` and `webPrepaidSystems_JV01`.
- **Now / process:** Processes **18–19 and 22**. Allocated hits are calculated; current final offset quantities round to whole numbers and final JV offset amounts to two decimals. Legacy offsets can retain fractional quantities.
- **Need:** **accounting decision and examples**. A different approved rule requires an output-function migration/test, not a Glue job.

**Why this matters:** rounding individual lines before summing can give a different result from rounding only the final total. This affects both quantities and the debit/credit amounts that must reconcile.

**Decision to record:** request an example with fractional quantities and amounts containing more than two decimals. Ask separately when allocated quantities, offset quantities, allocated money and final JV money should be rounded, and how any remaining difference is treated. Record the expected final lines/totals. Do not assume that one rounding rule applies to every stage.

### Where to look in the code

- **Legacy amounts/hits:** [dbo.webPrepaidSystems_FormatC133.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC133.View.sql:8) — allocated amount/quantity; [dbo.webPrepaidSystems_FormatC145.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC145.View.sql:8) and [dbo.webPrepaidSystems_FormatC146.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_FormatC146.View.sql:8) — offset calculation/summing.
- **Current rounding:** [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:276) — allocated `amount2`/`hits2`; line 283 rounds summed offset hits; line 295 begins final JV money rounding.
- **Legacy final export values:** [dbo.webPrepaidSystems_JV01.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV01.View.sql:8) — inspect `ABS(AMOUNT2)` and `ABS(HITS2)` rather than assuming its final precision matches the modern function.
- **Existing difference test:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1497) — the documented fractional broadband quantity case. It characterizes a difference; it is not accounting approval of the new rule.

## 8. Is the prepaid membership check only a report, or should it stop Freeze?

**Type: business decision + verification.** Legacy report definitions are available and current report APIs exist. This is not a missing report; blocking Freeze would be an additional policy decision.

- **Ask:** “If a revenue type/sub-product is missing from the GHP-PREPAID reference category, should we only report it or block Freeze? Are both the all-records and GP-non-BB checks required?”
- **Legacy:** `tvZTF0455S_validationRptSel` and `tvZTF0455S_validationV2RptSel`, comparing revenue type/sub-product against `BRAND = GHP-PREPAID`; the V2 check restricts the GP/non-BB population.
- **Now / process:** Processes **21 and 23**. Membership JSON/CSV APIs are implemented, but this check is not an additional Freeze gate. Missing source BRAND is reported as unverified.
- **Need:** **business decision** and authentic mapping metadata. Only add a validation gate if approved; no new UI controls are assumed.

**Why this matters:** a missing prepaid-category pair is not necessarily the same as a missing account mapping. It may be an exception someone reviews, rather than a reason to stop the whole workflow. The available report definitions do not by themselves prove a Freeze-blocking policy.

**Decision to record:** ask who reviewed these reports, what action they took, and whether posting could continue with an exception. Confirm both report populations and the source BRAND requirement. If blocking is required, identify the exact condition, whether overrides are permitted and who approves them before adding a new validation rule. Existing reports remain implemented either way.

### Where to look in the code

- **Legacy checks:** [dbo.tvZTF0455S_validationRptSel.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.tvZTF0455S_validationRptSel.View.sql:8) and [dbo.tvZTF0455S_validationV2RptSel.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.tvZTF0455S_validationV2RptSel.View.sql:8) — inspect the pair join, `GHP-PREPAID` filter and V2 selection.
- **Current report definitions:** [legacyRulesMigration.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/legacyRulesMigration.ts:51) — `prepaid_reference_membership`, `prepaid_membership_report` and `prepaid_membership_report_v2`.
- **Current service/routes:** [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:860) — `referenceMembership()`; [router.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/api/router.ts:457) — JSON/CSV routes. Search for `REFERENCE_MEMBERSHIP_SOURCE_BRAND_UNVERIFIED`.
- **Existing tests:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1652) — membership populations; line 1710 tests missing `source_brand`. For actual Freeze blockers, inspect `prepaid_build_outputs` in [migrations.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/migrations.ts:251); membership is not silently added there.

## 9. Does the implemented XLSX workbook match the accepted EG/SG template?

**Type: confirmed file type + template/operating verification.** The user confirmed XLSX and the backend now generates real workbooks. File type is no longer missing; exact accepted template/cell requirements still need an example.

- **Ask:** “Can you share one accepted EG and SG XLSX workbook? Do these four sheets, the 40 JV column headers/order, filenames and text-preserved account/decimal cells meet the manual SAP process? Are any particular cells required to be numeric/date rather than text?”
- **Legacy:** `webPrepaidSystems_JV01`, EG/SG JV views and SQL Agent jobs `Prepaid_Reclass_Preload_P10_EG_Only_AdHoc` / `Prepaid_Reclass_Preload_P10_SG_Only_AdHoc`.
- **Now / process:** Processes **4, 22 and 24**. An explicit `fileType: "xlsx"` manual profile generates Layout, Allocation, Reconciliation and JV sheets; historical delimited profiles remain unchanged. The workbook keeps decimal strings/account codes as text to avoid precision loss. Automatic SAP delivery remains off.
- **Need:** accepted EG/SG workbook samples and operator confirmation of the template/cell types. This unblocks **profile approval and real acceptance**, not another XLSX writer. Original P10 job steps are needed only for a separate request to reproduce historical automatic delivery.

**Why this matters:** valid XLSX is not automatically the accepted SAP workbook. A numerical accounting value stored as text preserves precision but may need an approved numeric-cell convention for a particular import template. That decision must come from a sample, not a guess that changes values.

**Request a concrete handoff:** an accepted XLSX per region showing headers, sheet names, fractional quantities, long/zero-prefixed account codes and date/number cell formats. Confirm whether one workbook per regional revision inside the current History ZIP is appropriate. Do not request BOM, text delimiters or line endings for XLSX. Compare accepted examples before approving the profile or changing the writer.

### Where to look in the code

- **Legacy field content/order:** [dbo.webPrepaidSystems_JV01.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV01.View.sql:8), [dbo.webPrepaidSystems_JV_EGHor.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV_EGHor.View.sql:8) and [dbo.webPrepaidSystems_JV_SGHor.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webPrepaidSystems_JV_SGHor.View.sql:8). These are SQL result definitions, not the physical export script.
- **Current format contract:** [contracts.ts](../src/modules/prepaid/domain/contracts.ts), manualReportFormatSchema and jvHeaders. The XLSX manual profile does not require text transport settings; integrationSchema retains historical text delivery compatibility.
- **Current frozen-file creation:** [reportService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/reportService.ts:82) — immutable/fallback format selection and JV serialization; [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:771) — `freeze()` captures the reviewed format.
- **Workbook code/tests:** [reportWorkbook.ts](../src/modules/prepaid/infrastructure/reportWorkbook.ts), [prepaid.reportWorkbook.test.ts](../tests/prepaid.reportWorkbook.test.ts), and the XLSX Freeze/History HTTP test in [prepaid.integration.test.ts](../tests/prepaid.integration.test.ts). Generated workbook checks are not proof of SAP acceptance.

## 10. Is manual SAP execution the intended replacement for legacy automatic delivery?

**Type: new-workflow decision.** Legacy automatic job triggering is visible. Manual staging is the current design, not a forgotten legacy trigger.

- **Ask:** “The new design freezes and stages a region, then users download its reports. Is manual SAP execution acceptable? Who downloads, posts and verifies it, and how do we prevent posting the same file twice?”
- **Legacy:** regional Freeze procedures started the P10 export/send jobs automatically.
- **Now / process:** Processes **23–25**. Freeze locks only the selected EG or SG revision. It does not send/post to SAP; automatic delivery work is disabled by default.
- **Need:** **operating decision and named owner**. Automatic delivery is not a missing requirement of the current design. If required instead, it is a separate SAP integration project needing posting/receipt/retry rules and explicit approval.

**Why this matters:** Freeze, file delivery and successful SAP posting are three different events. In the current flow, Freeze confirms only an immutable staged revision. A download is not evidence that the journal was posted.

**Decision to record:** confirm the manual route with the accounting/SAP owner, including who posts, where the SAP document number/result is recorded, and what happens after rejection or an uncertain outcome. If automatic delivery is required instead, recover the old transport/receipt steps and define duplicate prevention, retry and correction rules before enabling an integration. Do not switch on automatic delivery merely to match the old job trigger.

### Where to look in the code

- **Legacy automatic triggers:** [dbo.sp_Prepaid1_EGLayout_Freeze.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_Freeze.StoredProcedure.sql:39) and [dbo.sp_Prepaid1_SGLayout_Freeze.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_SGLayout_Freeze.StoredProcedure.sql:41) — P10 job names and `sp_start_job`.
- **Current regional staging:** [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:771) — `freeze()`; [router.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/api/router.ts:420) — regional Freeze route; [PrepaidRoute.tsx — freeze action](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:550) — UI request.
- **Historical delivery boundary:** [worker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/worker.ts:58) — `tick(allowLegacyDelivery = false)`; `deliver()` starts at line 552. Existing delivery code is not an instruction to enable it.
- **Existing test:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:673) — manual Freeze creates immutable staged reports without delivery jobs/AWS dispatch.

## 11. Who may edit a frozen layout, and what should Reset preserve?

**Type: permission/workflow decision.** Legacy controls and modern Edit/Reset code exist. Confirm the intended access policy and accept the new immutable-history behavior.

- **Ask:** “Was Unfreeze limited to a special group? Should users only see their own work or shared team history? Is it acceptable that Edit creates a new draft and Reset preserves all frozen reports?”
- **Legacy:** regional UnFreeze/Reset procedures and group-control views, including `webdcPrepaidSystemsUcv_010`.
- **Now / process:** Processes **3 and 26–27**. Access/ownership checks exist. Edit clones a draft; frozen records remain unchanged. Reset clears active work, not immutable history. Admin status does not bypass another user's ownership.
- **Need:** **permission/workflow decision**. Add API/access changes only if approved; do not restore legacy global clearing or mutate frozen reports.

**Why this matters:** allowing a second edit must not silently change a report that someone already used for SAP. Access to another user's history is also separate from being an administrator. These differences affect daily operations, not just screen permissions.

**Decision to record:** ask for a simple role list: who can upload, edit a draft, create a new draft from frozen data, Freeze, Reset and view team history. Ask what happens when an already-posted revision needs correction; the current draft-cloning flow does not itself reverse a SAP posting. Confirm what Reset should detach and what evidence/history must remain.

### Where to look in the code

- **Legacy controls:** [dbo.webdcPrepaidSystemsUcv_010.View.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/DCSTDIR1/DCSTDIR1/dbo.webdcPrepaidSystemsUcv_010.View.sql:8) — special group control; [dbo.sp_Prepaid1_EGLayout_UnFreeze.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_UnFreeze.StoredProcedure.sql:8) and [dbo.sp_Prepaid1_EGLayout_ResetLayout.StoredProcedure.sql](C:/Users/rccco/Downloads/DCS2_Legacy_4_RCC_DB-20260923T061118Z-1-001/DCS2_Legacy_4_RCC_DB/etl_db_web/etl_db_web/dbo.sp_Prepaid1_EGLayout_ResetLayout.StoredProcedure.sql:8) — examples of legacy regional state changes.
- **Current permissions/ownership:** [rbac.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/rbac.ts:34) — `assertModuleAccess()`; [repository.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/infrastructure/repository.ts:53) — `own()`. These implement current access, not a proven match to every legacy special group.
- **Current draft/reset behavior:** [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:639) — `edit()`/`openDraft()`; [workspaceService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/workspaceService.ts:332) — active `reset()`; [PrepaidRoute.tsx — Edit action](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:517) and [PrepaidRoute.tsx — Reset action](C:/Users/rccco/Documents/esatp-web-portal/esatp-webapp/src/routes/PrepaidRoute.tsx:561).
- **Existing tests:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:915) — preserved frozen reports during reset; line 1770 checks HTTP authentication/module/owner/admin isolation.

## 12. What can we use to prove the new results are correct, and who owns deployment?

**Type: verification + new-system setup.** Accepted legacy results are needed as comparison evidence. Actual AWS deployment/settings must come from the new deployment owner, not from legacy SQL job names.

- **Ask:** “Can you provide a complete approved month: raw inputs, mapping, final EG/SG layouts, allocation/reconciliation and accepted JV files? Who can confirm the totals and who should own the new AWS workflow?”
- **Legacy:** the actual extraction/import/Save/Freeze/export chain, including any missing referenced views such as SG Format B07 or Recon02/03 if they were used.
- **Now / process:** Processes **4, 8–12 and 20–24**. Synthetic tests exist; real legacy-to-current comparison and AWS/SAP acceptance remain. Four source child workflows have been inspected, but the complete isolated Standard V2 preparation workflow/bridge is still not established.
- **Need:** an approved test pack, expected results, accounting/SAP reviewer and deployment owner. The legacy owner can explain the old jobs; the AWS owner must provide actual state-machine, S3 and role settings. Do not ask anyone to invent them from the legacy job names.

**Why this matters:** tests with synthetic data prove selected code behavior, not that real legacy accounting results are reproduced. One approved full-month pack lets us compare each stage and identify whether a difference originates in extraction, editing, allocation or formatting.

**Request a concrete handoff:** inputs and mapping from the same period, imported layouts, the final saved adjustments, allocation/reconciliation results and the exact accepted JV files. Include any manual corrections or exceptions made during that run. Name who signs off the comparison and who deploys/operates the AWS producer; these may be different people. Missing legacy dependencies should be recovered before declaring the new flow production-ready.

### Where to look in the code

- **Legacy flow entry points:** start from the extraction trigger in item 1, import procedures in item 3 and regional export triggers in item 10. Follow their object/job references; the missing dependencies do not become complete merely because a wrapper exists.
- **Current operating setup:** [integrationReadiness.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/domain/integrationReadiness.ts:30) — `prepaidConfigurationReadiness()`; [runService.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/modules/prepaid/application/runService.ts:84) — admin `configure()`; [config.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/config.ts:1) — environment schema (not credential values).
- **Current worker/runtime:** [prepaidWorker.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/src/prepaidWorker.ts:1) — worker entry point and separate background loop; [compose.yml](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/compose.yml) and [compose.deploy.yml](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/compose.deploy.yml) — opt-in Prepaid worker/migration services. These do not contain a deployed raw-source producer.
- **Existing evidence:** [prepaid.integration.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.integration.test.ts:1059) and [prepaid.readiness.test.ts](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/tests/prepaid.readiness.test.ts:16) — synthetic calculation/readiness coverage; [create-prepaid-upload-samples.mjs](C:/Users/rccco/Documents/esatp-web-portal/esatp-coreapi/scripts/create-prepaid-upload-samples.mjs:6) — synthetic sample-pack generator, not production source fixtures. Request the real accepted pack to compare against these paths.

## Ask for these first

1. The **extraction and EG/SG export job steps**, plus the source-view definitions.
2. One **complete approved month** of inputs, mapping and expected outputs.
3. The **real cycle list** and **accepted SAP file specification**.
4. Answers to the calculation/permission decisions above and the names of the accounting, SAP and deployment owners.

Use approved channels for source data and redact sensitive records consistently if necessary. Do not put credentials in this document.

## Where this connects to the current code

Paths below are under `esatp-coreapi`; the UI remains the existing two-step screen.

| Workflow part | Current code |
| --- | --- |
| Setup checks and settings | [integrationReadiness.ts](../src/modules/prepaid/domain/integrationReadiness.ts), [runService.ts](../src/modules/prepaid/application/runService.ts); existing `/readiness` and admin `/integration` APIs |
| Upload contract and source shapes | [contracts.ts](../src/modules/prepaid/domain/contracts.ts), [workspaceService.ts](../src/modules/prepaid/application/workspaceService.ts) |
| External preparation and verification | [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts) |
| Reference export reader | [referenceProvider.ts](../src/modules/prepaid/application/referenceProvider.ts) |
| Financial calculation/output functions | [migrations.ts](../src/modules/prepaid/infrastructure/migrations.ts) |
| Original-total policy and membership | [legacyRulesMigration.ts](../src/modules/prepaid/infrastructure/legacyRulesMigration.ts) |
| Save/Edit/Freeze permissions and commands | [runService.ts](../src/modules/prepaid/application/runService.ts) |
| Frozen downloads | [reportService.ts](../src/modules/prepaid/application/reportService.ts) |

The process numbers refer to the [full Prepaid Re-Class guide](PREPAID_RECLASS_GUIDE.md). This is a handoff checklist, not a second implementation guide or a claim that existing APIs/SPs are missing.
