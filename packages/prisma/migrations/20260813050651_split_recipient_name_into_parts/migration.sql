-- Store the recipient name in parts so a NAME field can be bound to a single
-- part (first / middle / last) instead of stamping the whole string.
--
-- "name" is deliberately kept and remains the full-name value used for display,
-- search (Recipient_name_trgm_idx), emails, certificates, audit logs, webhooks
-- and the public API. It is now recomputed from these parts whenever they are
-- written. No backfill is performed: existing rows keep their "name" and the
-- application falls back to splitting it when a part is empty.

-- AlterTable
ALTER TABLE "Recipient" ADD COLUMN     "firstName" VARCHAR(255) NOT NULL DEFAULT '',
ADD COLUMN     "middleName" VARCHAR(255) NOT NULL DEFAULT '',
ADD COLUMN     "lastName" VARCHAR(255) NOT NULL DEFAULT '';
