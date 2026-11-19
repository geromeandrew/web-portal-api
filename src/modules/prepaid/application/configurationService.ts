import type { PoolClient, Pool } from "pg";
import { AppError } from "../../../errors.js";
import { assertAdministrator } from "../../../rbac.js";
import { manualIntegrationSchema } from "../domain/contracts.js";
import type { z } from "zod";
import { PrepaidRepository } from "../infrastructure/repository.js";
import { prepaidConfigurationReadiness } from "../domain/integrationReadiness.js";
import { effectivePrepaidConfiguration } from "../domain/builtinConfiguration.js";
import { PrepaidReferenceCatalog } from "../infrastructure/referenceCatalog.js";

/** Configuration precedence, readiness and administrator approval. */
export class PrepaidConfigurationService {
  constructor(
    readonly repo: PrepaidRepository,
    private readonly builtinConfiguration?: unknown,
  ) {}
  private t = (name: string) => this.repo.table(name);
  async readiness() {
    const objects = [
      "runs",
      "upload_sessions",
      "snapshot_context",
      "integrations",
      "source_totals",
      "source_extractions",
      "reference_refreshes",
    ];
    const present = await this.repo.pool.query(
      // Materialize the target first: PostgreSQL may reorder WHERE predicates.
      // Do not deparse unrelated constraints while another schema is being migrated/dropped.
      "WITH workflow_constraint AS MATERIALIZED (SELECT oid FROM pg_constraint WHERE conrelid=to_regclass($2) AND conname='prepaid_source_extractions_workflow_check' AND contype='c' AND convalidated) SELECT name,to_regclass(name) IS NOT NULL present FROM unnest($1::text[]) name UNION ALL SELECT 'backend_source_context',EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($2) AND attname='context' AND NOT attisdropped) UNION ALL SELECT 'all_source_workflows',EXISTS(SELECT 1 FROM workflow_constraint WHERE pg_get_constraintdef(oid) LIKE '%charges_318%')",
      [objects.map((x) => this.t(x)), this.t("source_extractions")],
    );
    // Migration 009 is an additive admin capability. Existing installations
    // using an approved external reference export do not lose their upload path.
    const referenceExportsAvailable = !!present.rows.find(
      (r) => r.name === this.t("reference_refreshes"),
    )?.present;
    const schemaInstalled = present.rows
      .filter((r) => r.name !== this.t("reference_refreshes"))
      .every((r) => r.present);
    const hasIntegration = present.rows[3]?.present;
    const stored = hasIntegration
      ? (
          await this.repo.pool.query(
            `SELECT configuration FROM ${this.t("integrations")} WHERE id=true`,
          )
        ).rows[0]?.configuration
      : undefined;
    const effective = effectivePrepaidConfiguration(
      stored,
      this.builtinConfiguration,
    );
    const configuration = prepaidConfigurationReadiness(
      effective.configuration,
    );
    const parsed = manualIntegrationSchema.safeParse(effective.configuration);
    let referenceVersionAvailable = true;
    let referenceVersionMessage =
      "Historical S3 reference configuration is retained.";
    if (parsed.success && parsed.data.referenceVersion) {
      try {
        await new PrepaidReferenceCatalog(this.repo).assertAvailable(
          parsed.data.referenceVersion,
        );
        referenceVersionMessage =
          "The pinned approved reference version is installed in this PostgreSQL database.";
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        referenceVersionAvailable = false;
        referenceVersionMessage = error.message;
      }
    }
    const checks = [
      {
        code: "schema",
        status: schemaInstalled ? "configured" : "missing",
        message: schemaInstalled
          ? "Prepaid schema is installed."
          : "Install Prepaid migrations 001 through 008.",
      },
      ...configuration.checks,
      {
        code: "referenceVersion",
        status: referenceVersionAvailable ? "configured" : "missing",
        message: referenceVersionMessage,
      },
      {
        code: "referenceExports",
        status: referenceExportsAvailable ? "configured" : "missing",
        message: referenceExportsAvailable
          ? "Administrator reference refresh/export is available; live data and mapping approval still require verification."
          : "Install additive migration 009 to enable administrator SAP reference refresh/export. Existing approved external reference exports remain supported.",
      },
      {
        code: "externalVerification",
        status: "not_verified",
        message:
          "Configuration alone does not verify report parsing, live reference data, AWS execution or SAP acceptance.",
      },
    ];
    return {
      schemaInstalled,
      referenceExportsAvailable,
      integrationConfigured: configuration.integrationConfigured,
      configurationSource: effective.source,
      readyForUploads: schemaInstalled,
      readyForPreparation:
        schemaInstalled &&
        configuration.integrationConfigured &&
        referenceVersionAvailable,
      legacyBasis: configuration.legacyBasis,
      externalVerification: "not_verified",
      checks,
    };
  }
  async availableIntegration(db: Pool | PoolClient = this.repo.pool) {
    const result = await db.query(
      `SELECT configuration FROM ${this.t("integrations")} WHERE id=true`,
    );
    const parsed = manualIntegrationSchema.safeParse(
      effectivePrepaidConfiguration(
        result.rows[0]?.configuration,
        this.builtinConfiguration,
      ).configuration,
    );
    return parsed.success ? parsed.data : null;
  }
  async integration() {
    const configuration = await this.availableIntegration();
    if (!configuration)
      throw new AppError(
        409,
        "PREPAID_INTEGRATION_NOT_CONFIGURED",
        "Source files can be uploaded first. Preparation requires administrator configuration for ingestion, billing-cycle coverage and an approved export format.",
      );
    if (configuration.referenceVersion)
      await new PrepaidReferenceCatalog(this.repo).assertAvailable(
        configuration.referenceVersion,
      );
    return configuration;
  }
  async configure(
    userId: string,
    configuration: z.infer<typeof manualIntegrationSchema>,
  ) {
    await assertAdministrator(this.repo.pool, userId);
    if (configuration.referenceVersion)
      await new PrepaidReferenceCatalog(this.repo).assertAvailable(
        configuration.referenceVersion,
      );
    await this.repo.pool.query(
      `INSERT INTO ${this.t("integrations")}(id,configuration,updated_by) VALUES(true,$1,$2) ON CONFLICT(id) DO UPDATE SET configuration=excluded.configuration,updated_by=excluded.updated_by,updated_at=now()`,
      [JSON.stringify(manualIntegrationSchema.parse(configuration)), userId],
    );
    return { configured: true };
  }
}
