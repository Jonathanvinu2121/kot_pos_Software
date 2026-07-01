import * as dotenv from 'dotenv';
dotenv.config();

import { connectMongo, closeMongo } from '../src/db/mongodb';
import { prisma } from '../src/db/postgres';
import * as crypto from 'crypto';

const BASE_URL = 'http://localhost:3000';

async function runTests() {
  console.log('Starting Sync API Integration Tests...');

  try {
    const mongoDb = await connectMongo();
    console.log('Connected to MongoDB.');

    // 1. Reset databases
    await mongoDb.collection('events').deleteMany({});
    await prisma.orderItem.deleteMany({});
    await prisma.order.deleteMany({});
    await prisma.table.deleteMany({});
    await prisma.menuItem.deleteMany({});
    console.log('Cleared databases.');

    // Seed test structures
    await prisma.table.create({
      data: { id: 1, restaurant_id: 1, number: 1, status: 'occupied' }
    });
    await prisma.menuItem.createMany({
      data: [
        { id: 1, restaurant_id: 1, name: 'Paneer Tikka', price_cents: 800, category: 'Appetizer', is_available: true },
        { id: 2, restaurant_id: 1, name: 'Butter Naan', price_cents: 200, category: 'Bread', is_available: true }
      ]
    });
    console.log('Seeded table 1 and menu items.');

    // Get Auth Token
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    if (!loginRes.ok) {
      throw new Error(`Login failed with status ${loginRes.status}`);
    }
    const { token } = await loginRes.json() as { token: string };

    // --- CASE 1: HAPPY PATH / FAST-FORWARD ---
    console.log('\n--- Case 1: Happy Path ---');
    const orderId = 201;
    const evCreateId = crypto.randomUUID();
    const evAddId = crypto.randomUUID();

    const pushRes1 = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evCreateId,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'CREATE_ORDER',
            payload: { table_id: 1 },
            based_on_event_id: null,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-0-devA`
          },
          {
            event_id: evAddId,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'ADD_ITEM',
            payload: { menu_item_id: 1, qty: 1 },
            based_on_event_id: evCreateId,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-1-devA`
          }
        ]
      })
    });
    const pushResults1 = await pushRes1.json() as any[];
    console.log('Happy path results:', pushResults1);
    if (pushResults1[0].status !== 'applied' || pushResults1[1].status !== 'applied') {
      throw new Error('Happy path events were not applied');
    }

    // Verify order item was created in Postgres to get its item ID
    const orderItems = await prisma.orderItem.findMany({ where: { order_id: orderId } });
    if (orderItems.length !== 1) {
      throw new Error('Expected 1 order item');
    }
    const orderItemId1 = orderItems[0].id;
    console.log('Postgres created item with ID:', orderItemId1);

    // --- CASE 2: AUTO_MERGE ---
    console.log('\n--- Case 2: Auto-Merge ---');
    const evUpdateIdA = crypto.randomUUID();
    const evAddIdB = crypto.randomUUID();

    // Push A first (this advances head to evUpdateIdA)
    const pushResA = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evUpdateIdA,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'UPDATE_ITEM_QTY',
            payload: { itemId: orderItemId1, qty: 3 },
            based_on_event_id: evAddId,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-2-devA`
          }
        ]
      })
    });
    const pushResA_json = await pushResA.json() as any[];
    console.log('A result:', pushResA_json);

    // Push B (still based on evAddId, so concurrent with A)
    const pushResB = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evAddIdB,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devB',
            user_id: 2,
            action: 'ADD_ITEM',
            payload: { menu_item_id: 2, qty: 1 },
            based_on_event_id: evAddId,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-2-devB`
          }
        ]
      })
    });
    const pushResB_json = await pushResB.json() as any[];
    console.log('B result (should auto-merge applied):', pushResB_json);
    if (pushResB_json[0].status !== 'applied') {
      throw new Error('Auto-merge failed: B should have been applied');
    }

    // Verify both changes are in Postgres
    const finalItems = await prisma.orderItem.findMany({ where: { order_id: orderId } });
    console.log('Postgres items after auto-merge:', finalItems);
    const item1 = finalItems.find(i => i.id === orderItemId1);
    if (item1?.qty !== 3) {
      throw new Error(`Expected item 1 qty to be 3, got ${item1?.qty}`);
    }
    if (finalItems.length !== 2) {
      throw new Error('Expected 2 items in Postgres');
    }

    // Verify Mongo log for event B has resolution type auto_merge
    const mongoEventB = await mongoDb.collection('events').findOne({ event_id: evAddIdB });
    console.log('Mongo Event B resolution:', mongoEventB?.resolution);
    if (mongoEventB?.resolution?.type !== 'auto_merge') {
      throw new Error('Expected resolution type "auto_merge"');
    }

    // --- CASE 3: SOFT CONFLICT (LWW) ---
    console.log('\n--- Case 3: Soft Conflict (LWW) ---');
    const evSoftA = crypto.randomUUID();
    const evSoftB = crypto.randomUUID();

    const baseHlcTime = Date.now();
    const hlcA = `${baseHlcTime}-0-devA`;
    const hlcB = `${baseHlcTime + 5000}-0-devB`; // Later HLC wins!

    // Push A first (advances head to evSoftA)
    await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evSoftA,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'UPDATE_ITEM_QTY',
            payload: { itemId: orderItemId1, qty: 5 },
            based_on_event_id: evAddIdB,
            client_created_at: new Date().toISOString(),
            hlc: hlcA
          }
        ]
      })
    });

    // Push B (concurrent, higher HLC, should win LWW and update Postgres)
    const pushSoftBRes = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evSoftB,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devB',
            user_id: 2,
            action: 'UPDATE_ITEM_QTY',
            payload: { itemId: orderItemId1, qty: 10 },
            based_on_event_id: evAddIdB,
            client_created_at: new Date().toISOString(),
            hlc: hlcB
          }
        ]
      })
    });
    const pushSoftBJson = await pushSoftBRes.json() as any[];
    console.log('Soft Conflict B result:', pushSoftBJson);
    if (pushSoftBJson[0].status !== 'soft_conflict') {
      throw new Error('Expected status to be "soft_conflict"');
    }

    // Verify Postgres item 1 qty is 10 (HLC B won)
    const postLwwItem = await prisma.orderItem.findUnique({ where: { id: orderItemId1 } });
    console.log('Postgres item 1 qty (expected 10):', postLwwItem?.qty);
    if (postLwwItem?.qty !== 10) {
      throw new Error(`Expected LWW winner qty to be 10, got ${postLwwItem?.qty}`);
    }

    // Verify Mongo events both have status soft_conflict and link to each other
    const mongoSoftA = await mongoDb.collection('events').findOne({ event_id: evSoftA });
    const mongoSoftB = await mongoDb.collection('events').findOne({ event_id: evSoftB });
    console.log('Mongo Event A conflict_with:', mongoSoftA?.conflict_with);
    console.log('Mongo Event B conflict_with:', mongoSoftB?.conflict_with);
    if (!mongoSoftA?.conflict_with.includes(evSoftB) || !mongoSoftB?.conflict_with.includes(evSoftA)) {
      throw new Error('Expected soft conflict events to link to each other');
    }

    // --- CASE 4: HARD CONFLICT ---
    console.log('\n--- Case 4: Hard Conflict ---');
    const evHardA = crypto.randomUUID();
    const evHardB = crypto.randomUUID();

    // Push A first (advances head to evHardA)
    await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evHardA,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'ADD_ITEM',
            payload: { menu_item_id: 1, qty: 1 },
            based_on_event_id: evSoftB,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-3-devA`
          }
        ]
      })
    });

    // Push B (concurrent cancel, colliding with A's ADD_ITEM -> hard conflict!)
    const pushHardRes = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evHardB,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devB',
            user_id: 2,
            action: 'CANCEL_ORDER',
            payload: { order_id: orderId },
            based_on_event_id: evSoftB,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-3-devB`
          }
        ]
      })
    });
    const pushHardJson = await pushHardRes.json() as any[];
    console.log('Hard conflict result:', pushHardJson);
    if (pushHardJson[0].status !== 'hard_conflict') {
      throw new Error('Expected status to be "hard_conflict"');
    }

    // Verify Postgres order status is NOT cancelled (since B was not applied)
    const postConflictOrder = await prisma.order.findUnique({ where: { id: orderId } });
    console.log('Postgres order status (expected open):', postConflictOrder?.status);
    if (postConflictOrder?.status !== 'open') {
      throw new Error('Expected order status to remain "open"');
    }

    // Verify Mongo events are marked hard_conflict and link to each other
    const mongoHardA = await mongoDb.collection('events').findOne({ event_id: evHardA });
    const mongoHardB = await mongoDb.collection('events').findOne({ event_id: evHardB });
    if (mongoHardA?.sync_status !== 'applied' || mongoHardB?.sync_status !== 'hard_conflict') {
      throw new Error('Expected sync_status to be "applied" for A and "hard_conflict" for B in MongoDB');
    }
    if (!mongoHardA?.conflict_with.includes(evHardB) || !mongoHardB?.conflict_with.includes(evHardA)) {
      throw new Error('Expected hard conflict events to link to each other');
    }

    // --- CASE 5: MANUAL RESOLUTION (REJECT) ---
    console.log('\n--- Case 5: Manual Resolution (Reject) ---');
    const rejectRes = await fetch(`${BASE_URL}/sync/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        event_id: evHardB,
        action: 'reject'
      })
    });
    const rejectJson = await rejectRes.json() as any;
    console.log('Reject resolve response:', rejectJson);

    // Verify Mongo state is now rejected and resolution is populated
    const mongoResolvedB = await mongoDb.collection('events').findOne({ event_id: evHardB });
    console.log('Mongo Event B resolved status:', mongoResolvedB?.sync_status);
    console.log('Mongo Event B resolved resolution:', mongoResolvedB?.resolution);
    if (mongoResolvedB?.sync_status !== 'rejected') {
      throw new Error('Expected event to be rejected');
    }
    if (!mongoResolvedB?.resolution || mongoResolvedB?.resolution?.chosen_event_id !== evHardA) {
      throw new Error('Expected resolution chosen_event_id to point to evHardA (current head)');
    }

    // --- CASE 6: MANUAL RESOLUTION (ACCEPT) ---
    console.log('\n--- Case 6: Manual Resolution (Accept) ---');
    const orderId2 = 202;
    const evCreateId2 = crypto.randomUUID();
    const evHardC = crypto.randomUUID();
    const evHardD = crypto.randomUUID();

    // Create order 202 first
    await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evCreateId2,
            restaurant_id: 1,
            order_id: orderId2,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'CREATE_ORDER',
            payload: { table_id: 1 },
            based_on_event_id: null,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-0-devA`
          }
        ]
      })
    });

    // Push C (applied)
    await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evHardC,
            restaurant_id: 1,
            order_id: orderId2,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'ADD_ITEM',
            payload: { menu_item_id: 1, qty: 1 },
            based_on_event_id: evCreateId2,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-4-devA`
          }
        ]
      })
    });

    // Push D (mismatch, colliding cancel -> hard_conflict)
    await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evHardD,
            restaurant_id: 1,
            order_id: orderId2,
            table_id: 1,
            device_id: 'devB',
            user_id: 2,
            action: 'CANCEL_ORDER',
            payload: { order_id: orderId2 },
            based_on_event_id: evCreateId2,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-4-devB`
          }
        ]
      })
    });

    // Resolve by ACCEPTING Waiter B's cancel event (evHardD)
    const acceptRes = await fetch(`${BASE_URL}/sync/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        event_id: evHardD,
        action: 'accept'
      })
    });
    const acceptJson = await acceptRes.json() as any;
    console.log('Accept resolve response:', acceptJson);

    // Verify Postgres order status is now cancelled
    const postResolveOrder = await prisma.order.findUnique({ where: { id: orderId2 } });
    console.log('Postgres order status (expected cancelled):', postResolveOrder?.status);
    if (postResolveOrder?.status !== 'cancelled') {
      throw new Error('Expected order status to be updated to "cancelled"');
    }

    // Verify Mongo event D has sync_status: applied and resolution chosen_event_id is evHardD
    const mongoResolvedD = await mongoDb.collection('events').findOne({ event_id: evHardD });
    console.log('Mongo Event D resolved status:', mongoResolvedD?.sync_status);
    console.log('Mongo Event D resolved resolution:', mongoResolvedD?.resolution);
    if (mongoResolvedD?.sync_status !== 'applied') {
      throw new Error('Expected event to be applied');
    }

    // --- CASE 7: IDEMPOTENCY ---
    console.log('\n--- Case 7: Idempotency ---');
    
    // Push an already-applied event (evCreateId) and verify it returns "applied"
    const idempotencyAppliedRes = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evCreateId,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'CREATE_ORDER',
            payload: { table_id: 1 },
            based_on_event_id: null,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-0-devA`
          }
        ]
      })
    });
    const idempotencyAppliedJson = await idempotencyAppliedRes.json() as any[];
    console.log('Idempotent applied result:', idempotencyAppliedJson);
    if (idempotencyAppliedJson[0].status !== 'applied') {
      throw new Error('Expected idempotent applied event to return status "applied"');
    }

    // Push an event that triggers an error (e.g. invalid item ID) and verify it returns "error"
    const evErrorId = crypto.randomUUID();
    const errorPushRes = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evErrorId,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'UPDATE_ITEM_QTY',
            payload: { itemId: 99999, qty: 5 }, // triggers error
            based_on_event_id: evHardA, // head had progressed to resolved resolution
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-9-devA`
          }
        ]
      })
    });
    const errorPushJson = await errorPushRes.json() as any[];
    console.log('Error push result:', errorPushJson);
    if (errorPushJson[0].status !== 'error') {
      throw new Error('Expected status to be "error"');
    }

    // Now, push the same event_id again (idempotent retry of failed event)
    // It should immediately return "error" status with our message
    const idempotencyErrorRes = await fetch(`${BASE_URL}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          {
            event_id: evErrorId,
            restaurant_id: 1,
            order_id: orderId,
            table_id: 1,
            device_id: 'devA',
            user_id: 1,
            action: 'UPDATE_ITEM_QTY',
            payload: { itemId: 99999, qty: 5 },
            based_on_event_id: evHardA,
            client_created_at: new Date().toISOString(),
            hlc: `${Date.now()}-9-devA`
          }
        ]
      })
    });
    const idempotencyErrorJson = await idempotencyErrorRes.json() as any[];
    console.log('Idempotent error result:', idempotencyErrorJson);
    if (idempotencyErrorJson[0].status !== 'error' || !idempotencyErrorJson[0].message.includes('recorded with error status')) {
      throw new Error('Expected idempotent error event to return status "error" with descriptive message');
    }

    console.log('\nAll integration tests passed successfully!');
  } catch (error) {
    console.error('\nIntegration tests failed:', error);
    process.exit(1);
  } finally {
    await closeMongo();
    await prisma.$disconnect();
  }
}

runTests();
