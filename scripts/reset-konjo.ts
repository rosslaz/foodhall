// One-off cleanup: remove the Konjo sandbox vendor + its menu items so it can be
// re-imported fresh (the prepConfirmed migration default retroactively marked
// pre-existing imported items as confirmed; a clean re-import sets the flag
// correctly). Safe to delete this file after running. Run:
//   npx tsx scripts/reset-konjo.ts
import { PrismaClient } from '@prisma/client';

const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const prisma = new PrismaClient();

async function main() {
  const vendor = await prisma.vendor.findFirst({
    where: { gotabLocationId: KONJO_LOC },
  });
  if (!vendor) {
    console.log('No Konjo vendor found (nothing to delete).');
    return;
  }
  const del = await prisma.menuItem.deleteMany({ where: { vendorId: vendor.id } });
  await prisma.vendor.delete({ where: { id: vendor.id } });
  console.log(`Deleted Konjo vendor "${vendor.name}" and ${del.count} menu item(s).`);
}

main()
  .catch((e) => {
    console.error('Reset failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
