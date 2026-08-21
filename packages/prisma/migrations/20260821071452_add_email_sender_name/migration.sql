-- CreateEnum
CREATE TYPE "EmailSenderNameMode" AS ENUM ('ORGANISATION', 'TEAM', 'CUSTOM');

-- AlterTable
ALTER TABLE "OrganisationGlobalSettings" ADD COLUMN     "emailSenderNameCustom" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "emailSenderNameMode" "EmailSenderNameMode" NOT NULL DEFAULT 'ORGANISATION';

-- AlterTable
ALTER TABLE "TeamGlobalSettings" ADD COLUMN     "emailSenderNameCustom" TEXT,
ADD COLUMN     "emailSenderNameMode" "EmailSenderNameMode";
