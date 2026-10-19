# Prepaid Step Functions: verified placement and integration

Updated: 19 October 2026 (Asia/Singapore).

## SAP reference job discovery and backend supply — 19 October 2026

**New implementation, separate from the ten extraction Step Functions:** the existing Glue job `isg-esatp-dv-sap_to_pg-gljo-ztf0455s` reads **SAPPRD.ZTF0455S** and writes **dgs4hana_tdir1_dbo.ztf0455s**. Its shared `GlueSapToPg.py` script uses truncate/overwrite without a WHERE filter. It refreshes reference records; it does **not** extract prepaid workbooks or send/post journals to SAP. No additional reference Step Function is required.

| Verified artifact | Value / meaning |
| --- | --- |
| Script | `s3://isg-esatp-rcc-scripts-os/glue/dv-v0.0.1/core/commons/scripts/GlueSapToPg.py` |
| Inspected script SHA-256 | `4f0c92d829f7c4f74db9b44e9335b3e38b6cb9105f647e20890919de18d51506` (19 October re-read). Changed bytes fail preflight until reviewed; the portal never edits them. |
| PG connection | `isg-esatp-dv-sap_to_pg-glco-postgres`; `GetConnection` uses `HidePassword: true`. The job's cluster endpoint and portal's instance endpoint currently resolve to the same public IP. SQL reports a private `/32` address; runtime verification handles this RDS NAT alias while checking database/port. Literal hostname inequality is not a target mismatch. |
| Source schema | All 17 original fields were checked in the sandbox: MANDT, BUKRS, HKONT, BRAND, WWSPA, WWBRD, SPB, WWST, PSTKY, GLDEF, INTLIND, TAXRATE, DUOM, EXSPB, AVERATE, ULI, SUBSER. Rates use exact numeric types, not JS floating-point conversion. |
| Current data / history | Latest broader read-only audit found zero usable ZTF0455S rows. No retained run history or job trigger was returned for this specific job. That does not prove it never ran or has no external scheduler. No live refresh was started. |
| Other AWS resources | `SAP-S3-Postgres` defaults to other SAP tables, not this mapping. `isg-esatp-dv-ext_sap_1/2/3-sf` are not this reference chain. `isg-esatp-dv-prep_reclass-gljo-extract_mgr` defaults to extraction jobs 1–5 only, not all twelve; do not substitute it for ten-workflow portal orchestration. |

### Implemented admin flow

1. Additive **009_prepaid_reference_refresh** creates `prepaid_reference_refreshes` and indexes. It does not create/seed/overwrite shared SAP records, change financial functions, modify old migrations or activate any integration. Existing 001–008 external-reference preparation remains compatible. `/readiness` exposes the optional `referenceExportsAvailable` capability.
2. Administrator `POST /api/workflows/prepaid/reference-exports` with UUID idempotency key, period, `scopeApproved: true`, and `mode: "export_existing"` reads real existing client-300/GLOB rows without starting a job. `refresh_and_export` additionally requires `sharedWritesApproved: true`, which explicitly authorizes **whole-table** overwrite by the existing Glue job. The GLOB restriction is the portal contract, not an explicit legacy-view restriction.
3. The worker checks job/script/target identity, all original columns/types and shared source activity; it coordinates with the existing native S3 extraction lock. It persists dispatch intent before the only `StartJobRun` call and disables SDK retries for that write. `--prepaid_reference_request_id` is an ignored correlation argument for recovery, not a validator or a required new script input. No Step Function definition changes are needed.
4. A verified successful refresh, or an explicit export-existing request, leads to a read-only repeatable-read snapshot. Original fields/BRAND distinction/exact decimals are retained and converted for validation. Empty/invalid rows fail. Fixed bounds: 250,000 rows / 20 MiB. Exact bytes are persisted before immutable S3 publication so a lost PUT response cannot make a retry export a changed shared table.
5. Poll `GET /reference-exports/:referenceId`. Completion returns `result.referenceExport` with key/prefix/hash/count, plus provenance; it does not approve mapping or update `/integration`. The administrator reviews and supplies `approved: true` through the existing configuration API. Native manifest assembly/provider then consume this immutable descriptor unchanged.
6. An uncertain start retains the lock and becomes `unknown`. `POST /reference-exports/:referenceId/reconcile` with `{}` discovers the marked **original** run, never dispatches a replacement. No visible run is not proof that no job was started. Multiple matches/pruned history require operator investigation; do not steal locks. A known failed refresh does not export and warns that shared data may need recovery.

**Runtime access:** backend IAM needs `glue:GetJob`, `GetJobRuns`, `GetJobRun`, `GetConnection` and explicitly scoped `StartJobRun` for the reference job; existing source activity inspection uses its current Glue/Step Functions read permissions. It also needs script `s3:GetObject`, conditional reference-prefix `GetObject`/`PutObject`, and existing coordination-lock Get/Put/Delete permissions. PostgreSQL needs SELECT on the upstream source and normal operation-table access. SAP credentials remain in the existing Glue job's runtime role/connection/secrets path; the portal does not retrieve them. AWS request connection/response timeouts and one-attempt write dispatch are explicit.

**Code:** [request/job contract](../src/modules/prepaid/domain/referenceRefresh.ts), [admin service](../src/modules/prepaid/application/referenceRefreshService.ts), [durable worker](../src/modules/prepaid/application/referenceRefreshWorker.ts), [Glue runner/preflight](../src/modules/prepaid/infrastructure/referenceRefreshRunner.ts), [read-only source](../src/modules/prepaid/infrastructure/referenceSource.ts), [migration 009](../src/modules/prepaid/infrastructure/referenceRefreshMigration.ts), [API contract](../src/modules/prepaid/api/openapi.ts). See [main guide Process 10](PREPAID_RECLASS_GUIDE.md#process-10--obtain-and-normalize-the-sap-reference-mapping) for request examples and recovery instructions.

**Deployment/evidence boundary:** migration 009 is tested on the isolated PostgreSQL cluster only and is not applied to sandbox by this change. No live job, S3 export/lock write, integration approval, portal connection change or UI change was performed. Real reference records still require an authorized SAP refresh/source-owner handoff; the backend cannot fabricate them. Cycle policy, accounting decisions and accepted XLSX fixtures remain separate requirements, not missing reference-job code.

**Live read-only preflight:** the actual new `PostgresReferenceSource.identity()` and `AwsReferenceRefreshRunner.verify()/idle()` passed against the configured sandbox and existing AWS job: all 17 columns/exact types, pinned script hash, database/server alias and absence of an active reference run. This establishes read access/configuration compatibility, not `StartJobRun` permission, successful SAP extraction or accounting acceptance. Technical provenance distinguishes `refreshExecutionVerified` from `sourceFreshnessVerified`; the latter stays false because a successful run/export is not an independent SAP-to-PG row-count/freshness attestation.

**Implementation verification:** TypeScript build and **177 focused Prepaid/OpenAPI/DB/security tests pass**, including **23 new reference tests** (eight real-SDK loopback protocol checks and fifteen isolated PostgreSQL/admin-HTTP/recovery checks). Migration 009 installs/repeats safely alongside all existing migrations. Tests also cover lease fencing, shared-job contention, missing optional 009 compatibility, invalid/empty real rows, whole-table approval, lost dispatch, lost object/lock acknowledgments and immutable snapshot reuse. Full API suite: **227 passed / four previously recorded unrelated auth-test failures**. Postman CLI still fails on its missing packaged dataset-engine SDK, so protocol checks use explicit local HTTP stand-ins instead. Relative documentation source links and instantiated route/OpenAPI counts were checked. No full live SAP refresh or browser/UI acceptance is claimed.

## Native SQL Server restore and confirmed fixes - 19 October 2026

**The backup is now restored and checked by native SQL Server, without Docker or virtualization.** The earlier offline findings below are retained as historical evidence; they are no longer the only verification.

| Item | Verified result |
| --- | --- |
| Runtime | Microsoft SQL Server 2022 LocalDB 16.0.1000.6; local inspection only, not a production SQL Server deployment. |
| Instance / database | `(localdb)\ESATPPrepaidLegacy20261019` / `etl_db_web`. Connect using Windows Authentication. Initial READ_ONLY checks passed, but a later read-only audit reported READ_WRITE; persistent write protection needs investigation. Do not execute recovered procedures. TRUSTWORTHY and DB_CHAINING were OFF at the original check. |
| Integrity | Original RESTORE VERIFYONLY succeeded; DBCC CHECKDB returned no findings. Original backup SHA-256 remains e29205ae6209c630eebd6de759b7c30fa146c9074a747852dc10791ce07fca50. |
| New backup | `C:/Users/rccco/Downloads/ESATP-Legacy-SQLServer/legacy-restored-20261019-011907.bak`, 3,959,296 bytes; COPY_ONLY + CHECKSUM, followed by successful RESTORE VERIFYONLY WITH CHECKSUM. SHA-256 b0c5c2ab985f0dbe25d310c5ebd56f61d9f79948fa5f302479c70cb9a4316192. |
| Recovered application data | Eight application tables; Prepaid upload group and seven filenames agree with offline decoding. BackgroundProcessing identifies sp_Prepaid1_Extract and is not running. TempDebug has a short Prepaid-related log, not job-step definitions. |
| Definition comparison | All **20 Prepaid web procedures + 11 Prepaid web views** match the supplied scripts after whitespace and dbo CREATE-name qualification normalization. No new financial formula was discovered in this backup. The supplied SQL inventory remains 562 files: 60 web + 502 supporting; Prepaid-named objects are 34 procedures, 53 views and six tables. |

**Scope:** this restores etl_db_web, not all databases it references. No legacy financial procedure or SQL Agent job was executed. The definition of sp_Prepaid1_Alloc_EG_MT even retains the original dynamic `SELECT SELECT` defect; the portal should not reproduce that typo. Cross-database consumers require the original DCSTDIR1/source/reference data, which this backup cannot manufacture.

### Discrepancies addressed in the current backend

1. **XLSX output:** the user confirmed the manual report file type. New explicit `format: {fileType: "xlsx", profile: "prepaid-manual-xlsx-v1", approved: true}` is supported without delimiter/encoding/line-ending fields. History still returns a ZIP; each XLSX regional revision contributes one genuine workbook with **Layout, Allocation, Reconciliation and JV** sheets. JV keeps the legacy 40 headers. Decimal strings and account codes are literal Excel text, preserving precision/leading zeros and avoiding formula interpretation. An accepted workbook is still needed to approve the exact template/cell-type requirements; this is not proof of SAP upload acceptance.
2. **Historical format preservation:** old frozen CSV/text configurations are not reinterpreted as XLSX. Frozen format metadata and deterministic inner/outer ZIP timestamps preserve repeat-download bytes. Automatic delivery remains disabled; its historical text-only contract is unchanged.
3. **Legacy-sized uploads:** Prepaid has a separate configurable `PREPAID_MAX_UPLOAD_BYTES`, default/maximum **104857600 (100 MiB)**. Other modules retain MAX_UPLOAD_BYTES. The source worker, shared landing verifier and both local parsers use the same 100 MiB ceiling. At most two in-memory Prepaid uploads are retained per API process until their responses complete.
4. **Bounds retained:** XLSX input expansion remains 128,000,000 bytes / 5,000 ZIP members; selected input data is bounded to 250,000 rows, 100 columns and 2,000,000 cells. Normalization timeout is 180 seconds and output stays capped. XLSX reports are capped at 250,000 cells, 32 MiB cell text and 32,767 characters/cell; excess returns an error, never truncation. These are implementation bounds, not new accounting rules. Real archived inputs still need acceptance against them.
5. **Proxy/config wiring:** frontend nginx/default.conf previously capped all requests at 5m. A more-specific Prepaid API location now permits 101m for multipart overhead and streams requests; other modules retain 5m. API compose templates and .env.example expose the separate Prepaid setting without editing the actual .env. This is deployment configuration only, not a screen change. Static proxy regression checks are included; a running Nginx syntax/live upload test was not available on this machine. Before deployment, run nginx -t and check upstream ingress limits too. Directive basis: [Nginx request size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size), [request buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering).

**Code:** [reportWorkbook.ts](../src/modules/prepaid/infrastructure/reportWorkbook.ts), [reportService.ts](../src/modules/prepaid/application/reportService.ts), [contracts.ts](../src/modules/prepaid/domain/contracts.ts), [upload.ts](../src/modules/prepaid/api/upload.ts), [limits.ts](../src/modules/prepaid/domain/limits.ts), [sourceNormalizer.ts](../src/modules/prepaid/infrastructure/sourceNormalizer.ts), [portal_source_extract.py](../infrastructure/prepaid/portal_source_extract.py), [normalize_source.py](../infrastructure/prepaid/normalize_source.py). No frontend controls or database migration were added for these changes.

**Checks:** build passes; 148 selected backend/OpenAPI checks and 20 Python tests pass, including real multipart/XLSX inputs above 4.5 MB. Tests use a fresh disposable PostgreSQL cluster at 127.0.0.1:55479, not the portal database. The first attempt against an older disposable cluster failed on missing system files; that cluster was stopped and preserved, not repaired/deleted. Full API suite: 204 pass / four previously recorded auth-test failures. AWS protocol checks use real SDK clients against loopback stand-ins; Postman CLI is unavailable because its packaged dataset-engine dependency is missing. No real extraction or SAP execution was started.

Frontend build and **55 tests** pass, including the two static proxy checks. An independent openpyxl reader also opened a generated workbook and confirmed all 40 JV columns, zero-prefixed account text and high-precision decimal text. This confirms genuine XLSX interoperability, not a SAP-accepted template. No live Nginx reload or external acceptance run was performed.

**Still needed:** real client-300 ZTF0455S records/export and refresh ownership; a complete required-cycle policy per 308/318 report family; accepted real accounting/workbook fixtures; runtime/shared-job authorization. The confirmed XLSX file type is no longer an unknown delimiter/encoding question. No integration or approval row was inserted automatically, no portal connection changed, and no sandbox data or AWS definition was edited.

See [SQL Server-restored comparison evidence](prepaid/setup/2026-10-19-native-sqlserver-restore.json). The private full catalog and restore/comparison scripts are under `C:/Users/rccco/Downloads/ESATP-Legacy-SQLServer/`. Do not execute the recovered procedures: some start external jobs or update shared financial tables if their original dependencies are present.

## Legacy backup follow-up without virtualization - 19 October 2026

**Historical first pass, before the native restore above:** the supplied folder also contains etl_db_web.bak. Docker could not start and virtualization was unavailable. A bounded read-only offline reader followed allocation/page links and row slots using the exported table schemas, indexing 356 pages with no duplicate IDs. The original hash was unchanged. Native restoration has now superseded the no-restore limitation of this first pass.

**Evidence limit:** this is decoded backup-page evidence, not a SQL Server-verified/recovered database. The reader does not replay transaction logs, perform DBCC validation or establish current production settings. Matching row counts and linked slots are stronger evidence than loose readable strings, but are not a substitute for an isolated restore on another machine.

| Recovered item | What it tells us | What it does not tell us |
| --- | --- | --- |
| SoureFile_Group: 5 decoded rows / metadata count 5; Prepaid group a7bb528c-ed66-40c1-a597-aa54f736d469 | ProcessName and Description are Prepaid Reclass; DirectoryPath is PrepaidSystems. | The relative directory is not an AWS prefix or permission/approval setting. Do not infer a complete absolute path from unrelated text strings. |
| SourceFiles_File: 11 / 11; seven rows reference that exact group | The historical configured filenames are KE24.xlsx, EG CALLCARD.xlsx, SG CALLCARD.xlsx, LOAD API_EG.xlsx, LOAD API_SG.xlsx, LOAD UP_EG.xlsx and LOAD UP_SG.xlsx. Each stores the XLSX MIME type in WildCardSearch. | This is not a complete extraction dependency list. It does not prove Recharge/308/318 were unnecessary, or that 411/sap_glbilled.txt were required. Current AWS Call Card names differ; retain the verified current contract rather than renaming it from this older configuration. |
| SourceFile_Group_Reports: 1 / 1, referencing the same group | Prepaid Report links to an SSRS folder under Reports_DACPRD / Prepaid Reports. | A report-folder link is not the P10 export writer or its delimiter/encoding settings. The old internal report server was not contacted. |
| FileUploads: 3 / 3 | These decoded rows are MyBSS configurations, not Prepaid. | Do not mistake them for Prepaid staging/final-path configuration. |
| SourceFile_Users: 0 / 0 | No user rows were recovered in this backup table. | This does not define current portal permissions or authorize all administrators. |
| Catalog user tables | No ZTF0455S, billing-cycle parameter or CPPackage table was found in the decoded etl_db_web user-table catalog. | This backup is not DCSTDIR1, dgS4HANA_TDIR1, CranPort or msdb. It cannot supply their actual data/job steps. |

The broader source review covered **562 SQL definitions** (60 etl_db_web + 502 DCSTDIR1). It found the external reference source and export/extract triggers, but no SQL Agent job-step definitions or relevant reference/cycle/writer seed records. In particular:

- ZTF0455S.View.sql reads external dgS4HANA_TDIR1.dbo.ZTF0455S and filters client 300. The portal additionally filters company GLOB: confirm that choice; do not label GLOB as an explicit legacy-view filter.
- The two AllBillCycles files define columns but contain no cycle values. No direct Prepaid reference to those tables was found in the supplied SQL. The current requirement for both 308 and 318 per expected cycle is a portal contract, not an established legacy policy.
- EG/SG Freeze start P10 SQL Agent jobs. Their steps and the actual CranPort CPPackage writer rows remain outside the supplied database artifacts. The 40-column JV view is implemented business content, not a physical file specification.
- The generic legacy upload controller permits 104,857,600 bytes (100 MiB), also reflected in Web.config. The earlier independent 4,500,000-byte parser limits were a real implementation gap; they are now addressed across upload/worker/landing/parser boundaries as described above.

**First-pass result, now supplemented by native restoration:** historical upload configuration was recovered, but not external reference rows or the full cycle policy. XLSX has since been confirmed by the user and implemented; exact workbook/SAP acceptance and real-file bounds still need fixtures.

See [scoped machine-readable backup findings](prepaid/setup/2026-10-19-legacy-backup-offline.json). Only documentation/evidence was updated: no portal DB, environment connection, AWS definition, source file or financial record was changed; no extraction/SAP execution was started.

## Verified available setup — 19 October 2026

The request to supply settings was checked against the actual sandbox, saved local setup, legacy source and relevant S3 locations. **Only technical settings can currently be supplied completely.** The existing data sources do not contain the missing accounting values. No integration row was inserted and no approval flag was fabricated.

| Setting | Value/evidence available now | Result |
| --- | --- | --- |
| Preparation | native_sources; all_sources; envPrefix isg-esatp-dv; ten workflow/twelve Glue mappings in sourceExtraction.ts | Supplied; no final assembly Step Function needed. |
| Environment | Sandbox postgres/web_portal with SSL; us-east-1; isg-esatp-rcc-storage-os | Already configured in ignored .env. |
| Reference data | dgs4hana_tdir1_dbo.ztf0455s and dcstdir1_dbo.ztf0455s both return **0 rows** | Source location/schema known, but no usable mapping export/key/hash/count can be supplied. No ZTF0455S export was found under the inspected prepaid_reclass or sap_to_s3 prefixes. |
| Required cycles | Both zparam_iccbs_allbillcycles and dczparam_iccbs_allbillcycles return **0 rows** | Full expectedCycles cannot be established. |
| Observed source cycles | 308 headers: cycle **21**, year **2023**, instance **9** (485 header rows). 318: cycle **27**, same year/instance (8,740 header rows). | Historical sample evidence only, not a complete current-period cycle list. Do not use the renamed B01 suffix as cycle 01. |
| JV content | Legacy webPrepaidSystems_JV01 supplies the implemented 40-column business content | Available; content is not a byte-format specification. |
| Manual report format | User-confirmed XLSX; genuine workbook writer and explicit format profile now implemented | No delimiter/encoding/line-ending settings are needed for XLSX. Approve the concrete sheet/header/cell requirements against accepted EG/SG examples. This does not recover the historical P10 writer. |
| Shared-job operation | Backend locking/activity/ownership/recovery safeguards implemented | Current coordination with external/manual operators is not a fact encoded in the old SQL. Do not infer it from successful past jobs. |

### What the real setup will look like

The following is a **partially supplied worksheet, not a runnable /integration payload**. Nulls identify values genuinely absent from the available references; they are not valid approvals or guessed defaults.

```json
{
  "preparationMode": "native_sources",
  "sourceExtraction": {
    "envPrefix": "isg-esatp-dv",
    "coverage": "all_sources",
    "sharedWritesApproved": null
  },
  "expectedCycles": null,
  "referenceExport": {
    "key": null,
    "prefix": null,
    "sha256": null,
    "rowCount": null,
    "approved": false
  },
  "format": {
    "fileType": "xlsx",
    "profile": "prepaid-manual-xlsx-v1",
    "approved": false
  }
}
```

Do not set expectedCycles to [21,27] solely because those two samples exist: the current contract requires **both** 308 and 318 for every configured cycle, while the supplied examples cover different cycles. Confirm the complete intended input set. Do not create synthetic HKONT/tax/average-rate/UOM mappings from KE24: those are real SAP reference data.

### Smallest concrete handoff still required

1. Populate/export the existing **ZTF0455S** reference with real client-300/GLOB records. Supply original-field JSONL, preserving account strings and BRAND versus WWBRD. The existing referenceProvider verifies the actual bytes/hash/count; nativeManifestBuilder consumes it. No new Step Function is required just to read that immutable export.
2. Supply the intended period's **complete cycle list**, including how each report family covers it.
3. Supply one **accepted EG/SG XLSX workbook** to approve sheet/header/cell/filename conventions and manual SAP handling. File type is known; do not ask for text delimiters or encoding for this XLSX path. Original P10 settings are needed only to reproduce that historical automatic delivery separately.
4. Confirm how sandbox operators coordinate shared Glue starts before enabling sharedWritesApproved.

### Additional real-file compatibility finding

Archived AWS input sizes include KE24 **25,494,826 bytes**, Load API SG **51,864,142 bytes**, and Load Up EG **50,120,824 bytes**. They exceeded the old 4.5 MB ceiling; all fit within the implemented 100 MiB input ceiling. Expanded-size/cell/time guards remain and must be checked against those real files. Passing generated >4.5 MB fixtures is not certification of these archived files.

Evidence: [machine-readable setup findings](prepaid/setup/2026-10-19-available-configuration.json). Relevant code: [contracts.ts](../src/modules/prepaid/domain/contracts.ts), [referenceConverter.ts](../src/modules/prepaid/domain/referenceConverter.ts), [sourceExtraction.ts](../src/modules/prepaid/domain/sourceExtraction.ts), [referenceProvider.ts](../src/modules/prepaid/application/referenceProvider.ts). No financial/source data was modified.


## Current result

All ten supplied workflows were inspected read-only in us-east-1: ACTIVE/STANDARD, with successful sampled historical executions. Definitions, twelve Glue job configurations, scripts, inputs and raw targets were checked. No AWS definition/job/script was edited, and no live extraction or SAP execution was started. Historical success is not a new portal acceptance test.

The old 308 JobRunId defect has been corrected externally: the inspected second task now has empty Arguments. The backend accepts this native definition; no owner correction is currently outstanding.

All ten sources are integrated. The new `native_sources` mode assembles their verified original-derived records and an approved reference export in the backend. It does not require an extra final V2 Step Function. Existing complete external-adapter configurations remain supported; old four-source configurations are not automatically expanded.

The frontend is unchanged: Upload file → Edit & validate, with no accounting-period/Create Run controls.

## 1. Where the workflows belong

All ten belong to guide Processes 8–12: source preparation. They replace the extraction responsibility triggered by legacy `sp_Prepaid1_Extract` → `Prepaid_Reclass_Preload_P02_Extract_04Mnt`. They are not Save, allocation, JV, Freeze or SAP-delivery jobs.

Each Glue job below is `isg-esatp-dv-prep_reclass-gljo-extract_N`; all targets are in `sdbtdir1_prepaid_dbo`.

| Step Function | Glue N | Input | Raw target |
| --- | --- | --- | --- |
| `isg-esatp-dv-prcl_ke24-sf` | 10 | KE24.xlsx | **`"dcKE24"`** |
| `isg-esatp-dv-prcl_cc_eg-sf` | 6 | CALLCARD_EG.xlsx | dcmanualcallcard |
| `isg-esatp-dv-prcl_cc_sg-sf` | 1 | CALLCARD_SG.xlsx | dccallcard_sg |
| `isg-esatp-dv-prcl_lu_eg-sf` | 7 | LOAD UP_EG.xlsx | dcload_up |
| `isg-esatp-dv-prcl_lu_sg-sf` | 8 | LOAD UP_SG.xlsx | dcload_up_sg |
| `isg-esatp-dv-prcl_la_eg-sf` | 2 | LOAD API_EG.xlsx | dcload_api |
| `isg-esatp-dv-prcl_la_sg-sf` | 3 | LOAD API_SG.xlsx | dcload_api_sg |
| `isg-esatp-dv-prcl_dl_mr-sf` | 9 | DL_Monthly_Recharge_summary_report.csv | dcmonthlyrechargesummary |
| `isg-esatp-dv-prcl_308_ba-sf` | **4 → 5** | 308. Billed Adjustments Monthly Summary Report_G_BCXX.xlsx | billed_adjustments_header_cycles, billed_adjustments_lineitem_cycles |
| `isg-esatp-dv-prcl_318_bc-sf` | **11 → 12** | 318. Billed Charges Summary Report_G_BCXX.xlsx | billed_charges_header_cycles, billed_charges_lineitem_cycles |

`XX` is an approved two-digit billing cycle, not an inferred calendar month. Header jobs retain the disposable input for the following detail job. The native wildcard patterns are `...Report_G_B**.xlsx` (308) and `...Report_G_BC**.xlsx` (318).

KE24 case matters: new `"dcKE24"` is not old lowercase `dcke24`. Some existing COPA views still read the lowercase table. The backend never treats those shared view rows as session evidence for the new extraction; neither table/view is renamed or overwritten by this integration.

## 2. The actual preparation flow

```text
Complete uploads → leased preparation request
  → read-only preflight of ALL selected workflows/jobs
  → KE24 first → remaining sources sequentially
       hash originals → local parser → immutable fragments
       lock shared folder → check conflicts/activity → stage owned copies
       native Step Function → verify Glue result → settle/clean owned copies
       backend receipt with actual child execution ARN
  → nativeManifestBuilder + approved immutable SAP reference export
  → eight canonical datasets + backend V2 manifest
  → verify hashes/counts/identities/cycles/exact-record multiset
  → ONE PostgreSQL transaction: snapshot → both layouts → calculations
  → Edit & validate → Save/review → regional Freeze → History download
  → assigned operator performs manual SAP execution
```

Every native execution receives **only** `{"env_prefix":"isg-esatp-dv"}`. No portalExtraction/PortalValidate state, script override or portal AWS receipt is required. Native outputs are Glue Id/JobName/JobRunState metadata. The backend creates its own receipts.

The final native manifest uses `producer: "backend"`, identity `backend:preparation:<id>` and ten real child receipts. The preparation's execution_arn stays NULL; no AWS parent execution is fabricated. External-adapter mode retains its actual final AWS execution/V2 contract.

## 3. Rules retained from legacy

| Source | Normalization and legacy relationship |
| --- | --- |
| KE24 | Exact financial headers; brand/CFU/revenue type, PHP amount/quantity; exactly one normal fiscal period 001–012. Feeds webdcKE24_EC_COPAValues-equivalent import. Mixed/special periods fail. |
| Call Card EG | Skip one row; business column 3, gross column 9. Keep individual amounts: PostgreSQL rounds EACH row before SUM, as WebdcCallCard_TotalGrossAmout did. |
| Call Card SG | CALLCARD sheet, skip four; trade column 2/internal 7. Latest valid dated row, not historical sum; period must agree with KE24. SG legacy importer used MAX(MonthNo). |
| Load Up | Skip four; EG type column 2/amount 10; SG type column 1/amount 9; regional decimal sums. Feeds WebdcLoadUp_TotalAmount/SG-equivalent import. |
| Load API | EG skip three/amount 6; SG skip two/amount 9; matching-region sums. Feeds existing regional Load/Rewards API rows. |
| Recharge | UTF-8 comma CSV with quoted fields; E/S customers, PS method, RP channel. Preserve amount signs; do not flip by CR/DR. Follows WebRechargeSumamry_TotalAmount/SG. |
| 308/318 | Verify each exact original's Cycle Code/Year/Instance. Preserve separate PHP adjustment/charge lines; existing SQL sums AMAXCEP by E/S into AMAXCE. Do not infer Cycle Instance or 04Mnt meaning. |

Strict headers, decimal arithmetic, uncached-formula rejection and immutable session records are deliberate portal safeguards, not proof of byte-identical legacy floating-point behavior. Real accounting fixtures still need acceptance. Financial import/allocation/reconciliation/JV remain in PostgreSQL; they were not moved into Glue.

## 4. Required administrator configuration

The inspected sandbox has **zero integration rows**. Code integration is ready, but operational approval is not auto-enabled. Use the existing admin `PUT /api/workflows/prepaid/integration`, then `GET /readiness`. This is not extra accounting UI.

For the new mode supply:

- `preparationMode: "native_sources"`.
- `sourceExtraction: { envPrefix: "isg-esatp-dv", coverage: "all_sources", sharedWritesApproved: true }`, only after shared-write coordination is approved.
- The actual `expectedCycles` list, e.g. the owner's approved two-digit cycles, not assumed defaults.
- `referenceExport: { key, prefix, sha256, rowCount, approved: true }` for a REAL approved immutable legacy-field JSONL export.
- `format: { fileType: "xlsx", profile: "prepaid-manual-xlsx-v1", approved: true }` after accepting the implemented manual workbook layout. Delimited fields apply only to retained historical text profiles, not XLSX.

`true` flags are assertions of real approval, not an approval system. Do not invent cycle lists, export hashes/counts or transport settings. Native mode does not require ingestStateMachine; never set that field to one partial source extractor. Omitted coverage preserves the historical four-source external-adapter path.

The reference provider expects original fields MANDT/BUKRS/HKONT/BRAND/WWBRD/WWSPA/WWST/SPB/TAXRATE/AVERATE/DUOM. It verifies the hash/count and converts client 300/company GLOB data, preserving BRAND versus WWBRD. It does not approve the mutable DB reference table or schedule a refresh.

Install `infrastructure/prepaid/requirements-backend.txt` into `.venv-prepaid`, or set PREPAID_PYTHON_EXECUTABLE. Existing Dockerfiles already include the helper. Run API AND `pnpm worker:prepaid:local`. Worker IAM needs Step Functions Describe/Start/List, Glue GetJob/GetJobRuns and scoped S3 read/list/conditional write/delete plus applicable KMS access. No definition-update permission is needed. Use a fresh preparation after changing configuration.

## 5. Isolation and recovery

Unchanged Glue jobs use shared inbound files and replace/write shared Aurora raw rows. They can move/delete input copies. The backend exposes **disposable owned copies only**, never immutable originals. A conditional S3 lock coordinates portal workers across databases; external/manual jobs do not automatically honor it. Coordinate those operators before approving shared writes.

The backend checks other running executions/jobs and matching foreign files, never overwrites foreign inputs or steals uncertain locks by timeout. Named starts recover lost responses. Manifest/artifact writes are conditional/immutable. A retry after a lost manifest-write response reuses completed extractors rather than starting them again.

Canonical financial evidence is the backend's independently hash-verified original-derived records. Glue success is required, but is **not proof that shared Aurora raw rows equal those session records**. Invalid references, periods, coverage or exact records block ready publication. This operational distinction still needs acceptance.

## 6. Database and code

API `.env` selects sandbox Aurora database postgres/schema web_portal with SSL; local settings are commented. Credentials remain ignored/local. The script suffix `:local` means TypeScript execution, not database selection.

Migrations 001–008 cover **35 portal Prepaid + 12 raw targets = 47 required tables**, **16 functions**, **7 views**. Migration 007 adds nullable private JSONB context; 008 expands workflows and codifies seven additional raw schemas. Existing names/types/case/nullability/identity/order are validated, not repaired/retyped. The main guide records sandbox backup/application evidence.

| File | Responsibility / search symbol |
| --- | --- |
| [sourceExtraction.ts](../src/modules/prepaid/domain/sourceExtraction.ts) | sourceWorkflows, selectedSourceWorkflows, validateLegacySourceDefinition |
| [sourceExtractionWorker.ts](../src/modules/prepaid/application/sourceExtractionWorker.ts) | advance: sequencing, native dispatch/poll, backend receipts |
| [sourceJobInspector.ts](../src/modules/prepaid/infrastructure/sourceJobInspector.ts) | verify/idle: read-only contracts and activity |
| [legacyLanding.ts](../src/modules/prepaid/infrastructure/legacyLanding.ts) | Conditional lock, owned copies, foreign-file conflicts, cleanup |
| [normalize_source.py](../infrastructure/prepaid/normalize_source.py) | normalize and individual parsers: local only, no AWS/DB calls |
| [nativeManifestBuilder.ts](../src/modules/prepaid/application/nativeManifestBuilder.ts) | build: ten verified sources + approved reference → V2 outputs |
| [preparationWorker.ts](../src/modules/prepaid/application/preparationWorker.ts) | tick: native/external modes and atomic PostgreSQL publication |
| [referenceProvider.ts](../src/modules/prepaid/application/referenceProvider.ts) | load: verified legacy-field export conversion |
| [sourceExtractionBridge.ts](../src/modules/prepaid/application/sourceExtractionBridge.ts) | Canonical exact-record multiset comparison |
| [allSourceMigration.ts](../src/modules/prepaid/infrastructure/allSourceMigration.ts) | Migration 008 and seven added raw schemas |

## 7. Verification and remaining work

Tests use disposable PostgreSQL, generated XLSX/CSV fixtures, fake S3/executions, and real AWS SDK clients against a loopback HTTP stand-in. They verify all ten mappings/twelve job contracts, env_prefix-only requests, both layouts, row rounding/signs, retries and invalid-reference failure. They do not execute real AWS jobs. Postman CLI was unavailable because its installed package lacks @postman/dataset-engine-sdk; repository-native HTTP simulation was used instead.

Before live acceptance:

1. Approve shared-job coordination and runtime role/access; operate the background worker.
2. Supply the approved immutable SAP reference export and its refresh owner; approve mapping semantics.
3. Configure actual cycles and approved physical export format; prepare a fresh session.
4. Compare real files and EG/SG/layout/allocation/JV/download outputs with accepted legacy results; agree manual SAP posting/deduplication ownership.
5. Clarify undocumented extraction-window rules and any accounting-policy differences with concrete examples.

**None of the ten sends to SAP.** Legacy Freeze invoked P10 EG/SG export/send jobs. Refined portal Freeze intentionally stages for manual execution. Automatic SAP posting is a separate approved integration, not a missing source Step Function.

Historical 15–16 October files under docs/prepaid/aws-verification remain audit evidence. Earlier four-source counts, 308-defect warnings and portal-branch deployment instructions are superseded, not current deployment instructions.
