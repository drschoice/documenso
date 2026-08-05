-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN     "signatureFontSize" INTEGER NOT NULL DEFAULT 18;

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "signatureFontSize" INTEGER NOT NULL DEFAULT 18;

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "signatureFontSize" INTEGER;
