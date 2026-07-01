/*
  Warnings:

  - A unique constraint covering the columns `[gotabOrderId]` on the table `Ticket` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "OrderItemStatus" AS ENUM ('ACTIVE', 'DROPPED');

-- DropIndex
DROP INDEX "Ticket_fireAt_idx";

-- DropIndex
DROP INDEX "Ticket_status_idx";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "droppedAt" TIMESTAMP(3),
ADD COLUMN     "status" "OrderItemStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_gotabOrderId_key" ON "Ticket"("gotabOrderId");

-- CreateIndex
CREATE INDEX "Ticket_status_fireAt_idx" ON "Ticket"("status", "fireAt");
