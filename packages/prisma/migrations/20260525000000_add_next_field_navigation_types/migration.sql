-- AlterTable
ALTER TABLE "DocumentMeta" ADD COLUMN "nextFieldNavigationTypes" "FieldType"[] NOT NULL DEFAULT ARRAY[]::"FieldType"[];
