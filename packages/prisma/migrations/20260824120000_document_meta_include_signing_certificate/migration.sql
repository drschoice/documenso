-- Per-envelope override for the signing certificate, sitting below the existing
-- organisation -> team chain. NULL means "inherit the resolved organisation/team setting", which is
-- the correct value for every pre-existing row, so there is deliberately no default and no backfill.
ALTER TABLE "DocumentMeta" ADD COLUMN "includeSigningCertificate" BOOLEAN;
