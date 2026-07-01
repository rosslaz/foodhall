-- CreateTable
CREATE TABLE "ScheduleOutcome" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "foodHallId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "targetReadyAt" TIMESTAMP(3) NOT NULL,
    "vendorCount" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "firstReadyAt" TIMESTAMP(3),
    "lastReadyAt" TIMESTAMP(3),
    "readySpreadMs" INTEGER,
    "targetErrorMs" INTEGER,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleOutcome_groupId_key" ON "ScheduleOutcome"("groupId");

-- CreateIndex
CREATE INDEX "ScheduleOutcome_foodHallId_idx" ON "ScheduleOutcome"("foodHallId");

-- AddForeignKey
ALTER TABLE "ScheduleOutcome" ADD CONSTRAINT "ScheduleOutcome_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GroupOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique index (S9): at most one live (non-cancelled) ticket per
-- vendor per group -- the invariant the double-lock race guard protects.
-- Hand-appended because Prisma cannot express partial indexes in
-- schema.prisma. If a future `prisma migrate dev` proposes DROPping this
-- index, that is the known Prisma limitation: delete the DROP statement from
-- the generated migration instead of accepting it.
CREATE UNIQUE INDEX "Ticket_groupId_vendorId_live_key" ON "Ticket"("groupId", "vendorId") WHERE "status" <> 'CANCELLED';
