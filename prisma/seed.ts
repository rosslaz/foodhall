import { PrismaClient } from '@prisma/client';
import { randomBytes, scryptSync } from 'node:crypto';

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function main() {
  const hall = await prisma.foodHall.create({
    data: { name: 'Central Food Hall', readyWindowS: 120 },
  });

  await prisma.user.create({
    data: { email: 'admin@foodhall.test', passwordHash: hashPassword('admin1234'), role: 'ADMIN' },
  });

  // Mock vendors are OPT-IN (review follow-up, 2026-07-18): real deployments
  // onboard vendors via GoTab import, and under VENDOR_ADAPTER=gotab these
  // fabricated vendors are landmines — fake gotabLocationId strings that look
  // "connected", items with no product mapping that render orderable and 400
  // on tap (the H1 guards stop the fire failure, not the UI dead end). Set
  // SEED_MOCK_VENDORS=true for the mock-adapter dev loop.
  const seedMocks = process.env.SEED_MOCK_VENDORS === 'true';
  const vendors = seedMocks ? [
    {
      name: 'Smash Burgers',
      items: [
        { name: 'Classic Smash', priceCents: 1100, prepSeconds: 600 },
        { name: 'Double Smash', priceCents: 1400, prepSeconds: 720 },
        { name: 'Fries', priceCents: 500, prepSeconds: 300 },
      ],
    },
    {
      name: 'Taco Stand',
      items: [
        { name: 'Carnitas Taco', priceCents: 450, prepSeconds: 240 },
        { name: 'Al Pastor Taco', priceCents: 450, prepSeconds: 300 },
        { name: 'Chips & Guac', priceCents: 700, prepSeconds: 120 },
      ],
    },
    {
      name: 'Pour House',
      items: [
        { name: 'Craft Lager', priceCents: 800, prepSeconds: 60 },
        { name: 'House Margarita', priceCents: 1100, prepSeconds: 120 },
        { name: 'Soda', priceCents: 300, prepSeconds: 30 },
      ],
    },
    {
      name: 'Wok This Way',
      items: [
        { name: 'Pad Thai', priceCents: 1300, prepSeconds: 540 },
        { name: 'Fried Rice', priceCents: 1100, prepSeconds: 420 },
        { name: 'Spring Rolls', priceCents: 600, prepSeconds: 240 },
      ],
    },
  ] : [];

  for (const v of vendors) {
    await prisma.vendor.create({
      data: {
        foodHallId: hall.id,
        name: v.name,
        gotabLocationId: `mock-${v.name.toLowerCase().replace(/\W+/g, '-')}`,
        menuItems: { create: v.items },
      },
    });
  }

  console.log('Seeded:');
  console.log('  Food hall:', hall.name, `(${hall.id})`);
  console.log('  Admin login: admin@foodhall.test / admin1234');
  console.log(
    seedMocks
      ? `  Vendors (mock): ${vendors.map((v) => v.name).join(', ')}`
      : '  Vendors: none — import real ones via the admin UI (SEED_MOCK_VENDORS=true for mocks)',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
