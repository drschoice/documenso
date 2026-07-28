-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN     "signatureFontFamily" TEXT NOT NULL DEFAULT 'Caveat';

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "signatureFontFamily" TEXT NOT NULL DEFAULT 'Caveat';

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "signatureFontFamily" TEXT;
