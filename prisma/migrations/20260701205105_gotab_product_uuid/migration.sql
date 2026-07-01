/*
  Warnings:

  - A unique constraint covering the columns `[vendorId,gotabProductUuid]` on the table `MenuItem` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "gotabProductUuid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_vendorId_gotabProductUuid_key" ON "MenuItem"("vendorId", "gotabProductUuid");
