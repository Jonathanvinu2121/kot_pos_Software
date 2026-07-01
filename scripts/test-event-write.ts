import * as dotenv from 'dotenv';
dotenv.config();

import { connectMongo, closeMongo } from '../src/db/mongodb';
import { writeEvent } from '../src/services/eventWriter';

async function runTest() {
  console.log('Starting MongoDB event-writer test...');

  try {
    const db = await connectMongo();
    
    // Clear events first to ensure a clean test run
    await db.collection('events').deleteMany({});
    console.log('Cleared existing events collection.');

    // 1. Write event 1: CREATE_ORDER
    const event1 = await writeEvent({
      event_id: 'e1d1f054-9426-4447-b86a-73d8a1db5ea1',
      restaurant_id: 1,
      order_id: 101,
      table_id: 2,
      device_id: 'device-waiter-a',
      user_id: 1,
      action: 'CREATE_ORDER',
      payload: { table_id: 2, created_by: 1 },
      based_on_event_id: null,
      client_created_at: new Date('2026-07-02T01:00:00Z'),
      hlc: '1719820000000-0-device-waiter-a',
    });
    console.log('Successfully wrote event 1:', event1.action);

    // 2. Write event 2: ADD_ITEM
    const event2 = await writeEvent({
      event_id: 'e2d1f054-9426-4447-b86a-73d8a1db5ea2',
      restaurant_id: 1,
      order_id: 101,
      table_id: 2,
      device_id: 'device-waiter-a',
      user_id: 1,
      action: 'ADD_ITEM',
      payload: { menu_item_id: 3, qty: 2 },
      based_on_event_id: 'e1d1f054-9426-4447-b86a-73d8a1db5ea1',
      client_created_at: new Date('2026-07-02T01:01:00Z'),
      hlc: '1719820060000-0-device-waiter-a',
    });
    console.log('Successfully wrote event 2:', event2.action);

    // 3. Write event 3: UPDATE_ITEM_QTY
    const event3 = await writeEvent({
      event_id: 'e3d1f054-9426-4447-b86a-73d8a1db5ea3',
      restaurant_id: 1,
      order_id: 101,
      table_id: 2,
      device_id: 'device-waiter-a',
      user_id: 1,
      action: 'UPDATE_ITEM_QTY',
      payload: { menu_item_id: 3, qty: 3 },
      based_on_event_id: 'e2d1f054-9426-4447-b86a-73d8a1db5ea2',
      client_created_at: new Date('2026-07-02T01:02:00Z'),
      hlc: '1719820120000-0-device-waiter-a',
    });
    console.log('Successfully wrote event 3:', event3.action);

    // Reading all events back from MongoDB
    console.log('\nReading all events back from MongoDB events collection:');
    const events = await db.collection('events').find().toArray();
    console.log(JSON.stringify(events, null, 2));

    if (events.length === 3) {
      console.log('\nVerification SUCCESS: All 3 events successfully written and retrieved!');
    } else {
      console.error(`\nVerification FAILURE: Expected 3 events, got ${events.length}`);
    }

  } catch (error) {
    console.error('Error during test execution:', error);
  } finally {
    await closeMongo();
    console.log('MongoDB connection closed.');
  }
}

runTest();
