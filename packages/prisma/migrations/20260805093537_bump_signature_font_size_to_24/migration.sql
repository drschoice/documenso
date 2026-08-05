-- Bump the default typed-signature size from 18 to 24, and apply it to pre-existing rows.
-- Guarded with `= 18` so any value already customised away from the original default is preserved.

-- New default for future rows.
ALTER TABLE "DocumentMeta" ALTER COLUMN "signatureFontSize" SET DEFAULT 24;
ALTER TABLE "OrganisationGlobalSettings" ALTER COLUMN "signatureFontSize" SET DEFAULT 24;

-- Backfill the org/team-level default and the per-document snapshot.
UPDATE "OrganisationGlobalSettings" SET "signatureFontSize" = 24 WHERE "signatureFontSize" = 18;
UPDATE "DocumentMeta" SET "signatureFontSize" = 24 WHERE "signatureFontSize" = 18;

-- Backfill the per-field size baked into existing signature fields (the value the renderer prefers).
-- Only touches signature fields still on the original 18 default; custom sizes (10/12/20/24/…) and
-- fields with no explicit fontSize (they fall through to the document setting) are left untouched.
UPDATE "Field"
SET "fieldMeta" = jsonb_set("fieldMeta", '{fontSize}', '24'::jsonb)
WHERE type = 'SIGNATURE'
  AND "fieldMeta" ? 'fontSize'
  AND "fieldMeta"->>'fontSize' = '18';
