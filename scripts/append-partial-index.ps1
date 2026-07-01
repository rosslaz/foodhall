# Appends the partial unique index (S9) to the LATEST migration — guarded so
# it can only ever run against a freshly created, not-yet-applied migration.
#
# HISTORY NOTE (2026-06-12): on its first run this script fired after
# `prisma migrate dev --create-only` had FAILED (database was down), so the
# "latest migration" was the already-applied schedule_outcomes migration and
# the index got appended there, corrupting its checksum. Remedy was
# `prisma migrate reset` (dev data only); the index now PERMANENTLY lives in
# 20260612040407_schedule_outcomes and Guard 1 below makes this script a
# no-op forever. Kept for reference if another partial index is ever needed.

$ErrorActionPreference = 'Stop'
$indexName = 'Ticket_groupId_vendorId_live_key'

# Guard 1: if the index already exists in ANY migration, do nothing. Prevents
# a duplicate CREATE INDEX from ever entering the migration history.
$existing = Get-ChildItem -Path 'prisma\migrations' -Recurse -Filter 'migration.sql' |
  Select-String -Pattern $indexName -List
if ($existing) {
  Write-Host "Index $indexName already present in:"
  $existing | ForEach-Object { Write-Host "  $($_.Path)" }
  Write-Host 'Nothing to do.'
  exit 0
}

$latest = Get-ChildItem -Path 'prisma\migrations' -Directory |
  Where-Object { $_.Name -match '^\d' } |
  Sort-Object Name |
  Select-Object -Last 1

if (-not $latest) {
  Write-Error 'No migration directories found under prisma\migrations'
  exit 1
}

# Guard 2: only append to the migration this flow just created. If
# --create-only failed (e.g. database down), the latest folder is some OLDER,
# ALREADY-APPLIED migration — appending there corrupts its recorded checksum
# and forces a reset. Refuse loudly instead.
if ($latest.Name -notmatch 'should_have_tier') {
  Write-Error ("Latest migration is '$($latest.Name)', not a should_have_tier migration. " +
    "Did 'npx prisma migrate dev --name should-have-tier --create-only' succeed? " +
    'Aborting: appending to an already-applied migration corrupts its checksum.')
  exit 1
}

$file = Join-Path $latest.FullName 'migration.sql'
if (-not (Test-Path $file)) {
  Write-Error "No migration.sql in $($latest.FullName)"
  exit 1
}

$sql = @"

-- Partial unique index (S9): at most one live (non-cancelled) ticket per
-- vendor per group -- the invariant the double-lock race guard protects.
-- Hand-appended because Prisma cannot express partial indexes in
-- schema.prisma. If a future ``prisma migrate dev`` proposes DROPping this
-- index, that is the known Prisma limitation: delete the DROP statement from
-- the generated migration instead of accepting it.
CREATE UNIQUE INDEX "Ticket_groupId_vendorId_live_key" ON "Ticket"("groupId", "vendorId") WHERE "status" <> 'CANCELLED';
"@

Add-Content -Path $file -Value $sql
Write-Host "Appended partial unique index to $file"
