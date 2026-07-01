import { PrismaClient, TableStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Clear any existing data first to ensure idempotency
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.menuItem.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.restaurant.deleteMany({});

  // 1. Create 1 Restaurant
  const restaurant = await prisma.restaurant.create({
    data: {
      name: "Chutney & Spice",
    },
  });
  console.log(`Created Restaurant: ${restaurant.name} (ID: ${restaurant.id})`);

  // 2. Create 5 tables (mix of available/occupied/needs_cleaning)
  const tablesData = [
    { number: 1, status: TableStatus.available, restaurant_id: restaurant.id },
    { number: 2, status: TableStatus.occupied, restaurant_id: restaurant.id },
    { number: 3, status: TableStatus.available, restaurant_id: restaurant.id },
    { number: 4, status: TableStatus.occupied, restaurant_id: restaurant.id },
    { number: 5, status: TableStatus.needs_cleaning, restaurant_id: restaurant.id },
  ];

  for (const table of tablesData) {
    const createdTable = await prisma.table.create({
      data: table,
    });
    console.log(`Created Table #${createdTable.number} with status ${createdTable.status}`);
  }

  // 3. Create 10 menu items (realistic Indian restaurant items, categories, and prices in price_cents)
  const menuItemsData = [
    { name: "Vegetable Samosa (2 pcs)", price_cents: 450, category: "Appetizer", restaurant_id: restaurant.id },
    { name: "Chicken Tikka Lal", price_cents: 1395, category: "Appetizer", restaurant_id: restaurant.id },
    { name: "Paneer Butter Masala", price_cents: 1595, category: "Mains", restaurant_id: restaurant.id },
    { name: "Chicken Biryani", price_cents: 1795, category: "Mains", restaurant_id: restaurant.id },
    { name: "Dal Makhani", price_cents: 1495, category: "Mains", restaurant_id: restaurant.id },
    { name: "Butter Naan", price_cents: 395, category: "Bread", restaurant_id: restaurant.id },
    { name: "Garlic Naan", price_cents: 450, category: "Bread", restaurant_id: restaurant.id },
    { name: "Basmati Rice", price_cents: 495, category: "Rice", restaurant_id: restaurant.id },
    { name: "Gulab Jamun (2 pcs)", price_cents: 595, category: "Dessert", restaurant_id: restaurant.id },
    { name: "Mango Lassi", price_cents: 495, category: "Beverage", restaurant_id: restaurant.id }
  ];

  for (const item of menuItemsData) {
    const createdItem = await prisma.menuItem.create({
      data: item,
    });
    console.log(`Created Menu Item: ${createdItem.name} (${createdItem.category}) - ${createdItem.price_cents} cents`);
  }

  // 4. Create 3 users (2 waiters, 1 kitchen role) with hashed PINs
  const usersData = [
    { name: "Rajesh Kumar", role: UserRole.waiter, pin: "1234" },
    { name: "Anita Sharma", role: UserRole.waiter, pin: "5678" },
    { name: "Vikram Singh", role: UserRole.kitchen, pin: "4321" }
  ];

  const saltRounds = 10;
  for (const user of usersData) {
    const pinHash = await bcrypt.hash(user.pin, saltRounds);
    const createdUser = await prisma.user.create({
      data: {
        name: user.name,
        role: user.role,
        pin_hash: pinHash,
        restaurant_id: restaurant.id,
      },
    });
    console.log(`Created User: ${createdUser.name} as ${createdUser.role} (PIN: ${user.pin})`);
  }

  console.log('Seeding completed successfully!');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Error during seeding:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
