import * as dotenv from 'dotenv';
dotenv.config();

import { app } from '../src/app';
import { connectMongo, closeMongo } from '../src/db/mongodb';
import { prisma } from '../src/db/postgres';
import { Server } from 'http';

const TEST_PORT = 3002;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  console.log('Starting REST API Integration Tests...');

  let server: Server | null = null;
  try {
    const mongoDb = await connectMongo();
    console.log('Connected to MongoDB.');

    // Clear events first to have a clean test run
    await mongoDb.collection('events').deleteMany({});
    console.log('Cleared MongoDB events collection.');

    // Reset orders and order items in PostgreSQL to keep it clean
    await prisma.orderItem.deleteMany({});
    await prisma.order.deleteMany({});
    console.log('Cleared PostgreSQL orders and order items.');

    server = app.listen(TEST_PORT);
    console.log(`Test server running on ${BASE_URL}`);

    // --- TEST 1: Login with correct PIN ---
    console.log('\n--- Test 1: POST /auth/login with correct PIN ---');
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' }) // Rajesh Kumar (waiter, restaurant 1)
    });
    if (!loginRes.ok) {
      throw new Error(`Login failed with status ${loginRes.status}`);
    }
    const loginData = await loginRes.json() as { token: string };
    const token = loginData.token;
    console.log('Login successful! JWT Token acquired.');

    // --- TEST 2: Login with incorrect PIN ---
    console.log('\n--- Test 2: POST /auth/login with incorrect PIN ---');
    const loginBadRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '9999' })
    });
    console.log(`Bad PIN status (Expected 401): ${loginBadRes.status}`);
    if (loginBadRes.status !== 401) {
      throw new Error('Expected login with bad PIN to fail with 401');
    }

    // --- TEST 3: Unauthorized Request ---
    console.log('\n--- Test 3: POST /orders without Token ---');
    const orderUnauthRes = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_id: 1 })
    });
    console.log(`Unauth status (Expected 401): ${orderUnauthRes.status}`);
    if (orderUnauthRes.status !== 401) {
      throw new Error('Expected request without token to fail with 401');
    }

    // --- TEST 4: Create Order ---
    console.log('\n--- Test 4: POST /orders (Create Order) ---');
    const createOrderRes = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ table_id: 1 })
    });
    if (!createOrderRes.ok) {
      const errorText = await createOrderRes.text();
      throw new Error(`Create order failed with status ${createOrderRes.status}: ${errorText}`);
    }
    const orderData = await createOrderRes.json() as { id: number; head_event_id: string };
    const orderId = orderData.id;
    const createEventId = orderData.head_event_id;
    console.log(`Order created successfully! ID: ${orderId}, head_event_id: ${createEventId}`);

    // Verify PostgreSQL order state
    const pgOrder = await prisma.order.findUnique({ where: { id: orderId } });
    if (!pgOrder) throw new Error('Order not found in PostgreSQL');
    if (pgOrder.head_event_id !== createEventId) {
      throw new Error(`Pg order head_event_id mismatch. Expected ${createEventId}, got ${pgOrder.head_event_id}`);
    }
    console.log('PostgreSQL order matches successfully.');

    // Verify MongoDB event state
    const mongoCreateEvent = await mongoDb.collection('events').findOne({ event_id: createEventId });
    if (!mongoCreateEvent) throw new Error('CREATE_ORDER event not found in MongoDB');
    console.log(`MongoDB event log matches successfully. Action: ${mongoCreateEvent.action}, based_on_event_id: ${mongoCreateEvent.based_on_event_id}`);

    // --- TEST 5: Add Line Item ---
    console.log('\n--- Test 5: POST /orders/:id/items (Add Item) ---');
    const addItemRes = await fetch(`${BASE_URL}/orders/${orderId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ menu_item_id: 3, qty: 2, notes: 'extra butter' }) // Paneer Butter Masala
    });
    if (!addItemRes.ok) {
      const errorText = await addItemRes.text();
      throw new Error(`Add item failed with status ${addItemRes.status}: ${errorText}`);
    }
    const itemData = await addItemRes.json() as { id: number };
    const itemId = itemData.id;
    console.log(`Item added successfully! ID: ${itemId}`);

    // Verify updated order head in PG
    const pgOrderAfterItem = await prisma.order.findUnique({ where: { id: orderId } });
    const addItemEventId = pgOrderAfterItem!.head_event_id!;
    console.log(`Updated head_event_id in PG: ${addItemEventId}`);

    // Verify MongoDB ADD_ITEM event
    const mongoAddItemEvent = await mongoDb.collection('events').findOne({ event_id: addItemEventId });
    if (!mongoAddItemEvent) throw new Error('ADD_ITEM event not found in MongoDB');
    if (mongoAddItemEvent.based_on_event_id !== createEventId) {
      throw new Error(`Causal chain broken! ADD_ITEM based_on_event_id (${mongoAddItemEvent.based_on_event_id}) does not match CREATE_ORDER event_id (${createEventId})`);
    }
    console.log('MongoDB ADD_ITEM event verified with correct based_on_event_id.');

    // --- TEST 6: Update Line Item (Qty and Status) ---
    console.log('\n--- Test 6: PATCH /orders/:id/items/:itemId (Update Qty & Status) ---');
    const updateItemRes = await fetch(`${BASE_URL}/orders/${orderId}/items/${itemId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ qty: 3, status: 'preparing' })
    });
    if (!updateItemRes.ok) {
      const errorText = await updateItemRes.text();
      throw new Error(`Update item failed with status ${updateItemRes.status}: ${errorText}`);
    }
    const updatedItemData = await updateItemRes.json() as { qty: number; status: string };
    console.log(`Item updated in DB. Qty: ${updatedItemData.qty}, Status: ${updatedItemData.status}`);

    // Verify order head updated in PG
    const pgOrderAfterUpdate = await prisma.order.findUnique({ where: { id: orderId } });
    const updateEventId = pgOrderAfterUpdate!.head_event_id!;
    console.log(`Updated head_event_id in PG after update: ${updateEventId}`);

    // Verify MongoDB events chain. Because we updated BOTH qty and status,
    // the server should have written two events: UPDATE_ITEM_QTY followed by UPDATE_ITEM_STATUS.
    const allEvents = await mongoDb.collection('events').find({ order_id: orderId }).toArray();
    console.log(`Total events logged for order: ${allEvents.length} (Expected: 4)`);
    if (allEvents.length !== 4) {
      throw new Error(`Expected 4 events total, got ${allEvents.length}`);
    }

    // Verify chronological causal chain links
    const createEv = allEvents.find(e => e.action === 'CREATE_ORDER');
    const addEv = allEvents.find(e => e.action === 'ADD_ITEM');
    const qtyEv = allEvents.find(e => e.action === 'UPDATE_ITEM_QTY');
    const statusEv = allEvents.find(e => e.action === 'UPDATE_ITEM_STATUS');

    if (!createEv || !addEv || !qtyEv || !statusEv) {
      throw new Error('Some events were not written correctly');
    }

    if (addEv.based_on_event_id !== createEv.event_id) throw new Error('Link 1 broken');
    if (qtyEv.based_on_event_id !== addEv.event_id) throw new Error('Link 2 broken');
    if (statusEv.based_on_event_id !== qtyEv.event_id) throw new Error('Link 3 broken');
    console.log('MongoDB chronological causal chain verified successfully: CREATE_ORDER -> ADD_ITEM -> UPDATE_ITEM_QTY -> UPDATE_ITEM_STATUS');

    // --- TEST 7: Cancel Order ---
    console.log('\n--- Test 7: POST /orders/:id/cancel (Cancel Order) ---');
    const cancelRes = await fetch(`${BASE_URL}/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    if (!cancelRes.ok) {
      const errorText = await cancelRes.text();
      throw new Error(`Cancel order failed with status ${cancelRes.status}: ${errorText}`);
    }
    console.log('Cancel order API responded with success.');

    // Verify PG order and order items are marked cancelled
    const pgFinalOrder = await prisma.order.findUnique({ where: { id: orderId } });
    if (pgFinalOrder!.status !== 'cancelled') {
      throw new Error(`Expected order status 'cancelled', got ${pgFinalOrder!.status}`);
    }
    const pgFinalItem = await prisma.orderItem.findFirst({ where: { order_id: orderId } });
    if (pgFinalItem!.status !== 'cancelled') {
      throw new Error(`Expected item status 'cancelled', got ${pgFinalItem!.status}`);
    }
    console.log('PostgreSQL order and order items correctly marked cancelled.');

    // Verify final Mongo events list
    const finalEventsList = await mongoDb.collection('events').find({ order_id: orderId }).toArray();
    console.log(`Final event count in Mongo: ${finalEventsList.length} (Expected: 5)`);
    const cancelEv = finalEventsList.find(e => e.action === 'CANCEL_ORDER');
    if (!cancelEv) throw new Error('CANCEL_ORDER event not found');
    if (cancelEv.based_on_event_id !== statusEv.event_id) {
      throw new Error(`Cancel event parent pointer broken. Expected ${statusEv.event_id}, got ${cancelEv.based_on_event_id}`);
    }
    console.log('MongoDB CANCEL_ORDER event verified with correct parent pointer.');

    console.log('\nALL TESTS PASSED SUCCESSFULLY! ✅');

  } catch (error) {
    console.error('\nTEST FAILED ❌', error);
  } finally {
    if (server) {
      server.close();
      console.log('Server stopped.');
    }
    await closeMongo();
    await prisma.$disconnect();
    console.log('Connections closed.');
  }
}

runTests();
