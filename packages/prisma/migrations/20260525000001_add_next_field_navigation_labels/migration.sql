-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN "nextFieldNavigationLabels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
