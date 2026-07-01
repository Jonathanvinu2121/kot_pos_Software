import express from 'express';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { prisma } from './db/postgres';
import { writeEvent } from './services/eventWriter';
import { authMiddleware } from './middleware/auth';
import { TableStatus, UserRole, OrderStatus, OrderItemStatus } from '@prisma/client';
import { broadcastToTable } from './services/socket';
import { connectMongo } from './db/mongodb';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. POST /auth/login — PIN-based, returns a JWT containing restaurant_id, role, user_id
app.post('/auth/login', async (req, res) => {
  const { pin, name, user_id } = req.body;
  if (!pin) {
    return res.status(400).json({ error: 'Pin is required' });
  }

  try {
    let users = [];
    if (user_id) {
      const user = await prisma.user.findUnique({ where: { id: Number(user_id) } });
      if (user) users.push(user);
    } else if (name) {
      users = await prisma.user.findMany({ where: { name } });
    } else {
      users = await prisma.user.findMany();
    }

    let authenticatedUser = null;
    for (const user of users) {
      const match = await bcrypt.compare(pin, user.pin_hash);
      if (match) {
        authenticatedUser = user;
        break;
      }
    }

    if (!authenticatedUser) {
      return res.status(401).json({ error: 'Invalid PIN or credentials' });
    }

    const secret = process.env.JWT_SECRET || 'supersecret_pos_key';
    const token = jwt.sign(
      {
        restaurant_id: authenticatedUser.restaurant_id,
        role: authenticatedUser.role,
        user_id: authenticatedUser.id
      },
      secret,
      { expiresIn: '1d' }
    );

    return res.json({ token });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. POST /orders — create an order for a table
app.post('/orders', authMiddleware, async (req, res) => {
  const { table_id } = req.body;
  if (!table_id) {
    return res.status(400).json({ error: 'table_id is required' });
  }

  try {
    const tableIdNum = Number(table_id);
    const user = req.user!;

    // Verify table belongs to user's restaurant
    const table = await prisma.table.findFirst({
      where: {
        id: tableIdNum,
        restaurant_id: user.restaurant_id
      }
    });

    if (!table) {
      return res.status(404).json({ error: 'Table not found or access denied for this restaurant' });
    }

    // Pre-allocate next order ID in PostgreSQL sequence
    const nextIdResult = await prisma.$queryRaw<[{ nextval: bigint }]>`
      SELECT nextval(pg_get_serial_sequence('orders', 'id'));
    `;
    const orderId = Number(nextIdResult[0].nextval);

    // Client event metadata
    const eventId = req.body.event_id || crypto.randomUUID();
    const deviceId = req.body.device_id || 'rest-api';
    const hlc = req.body.hlc || `${Date.now()}-0-rest-api`;
    const clientCreatedAt = req.body.client_created_at || new Date();

    // Call writeEvent (Mongo) with based_on_event_id set to null (since order is being created)
    let event;
    try {
      event = await writeEvent({
        event_id: eventId,
        restaurant_id: user.restaurant_id,
        order_id: orderId,
        table_id: table.id,
        device_id: deviceId,
        user_id: user.user_id,
        action: 'CREATE_ORDER',
        payload: { table_id: table.id, created_by: user.user_id },
        based_on_event_id: null,
        client_created_at: clientCreatedAt,
        hlc: hlc
      });
    } catch (err: any) {
      console.error('MongoDB writeEvent failed:', err);
      return res.status(500).json({ error: `Mongo event write failed: ${err.message}` });
    }

    // Wrap Postgres write in transaction
    let order;
    try {
      order = await prisma.$transaction(async (tx) => {
        return await tx.order.create({
          data: {
            id: orderId,
            restaurant_id: user.restaurant_id,
            table_id: table.id,
            status: OrderStatus.open,
            created_by: user.user_id,
            head_event_id: eventId
          }
        });
      });
    } catch (err) {
      console.error(`FATAL: MongoDB writeEvent succeeded (Event ID: ${eventId}) but Postgres write failed!`, err);
      return res.status(500).json({ error: 'Postgres transaction failed' });
    }

    try {
      const fullOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { order_items: true }
      });
      if (fullOrder) {
        broadcastToTable(fullOrder.table_id, fullOrder);
      }
    } catch (broadcastErr) {
      console.error('Failed to broadcast order update:', broadcastErr);
    }

    return res.status(201).json(order);
  } catch (error) {
    console.error('Create order error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. POST /orders/:id/items — add a line item
app.post('/orders/:id/items', authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);
  const { menu_item_id, qty, notes } = req.body;

  if (!menu_item_id || !qty) {
    return res.status(400).json({ error: 'menu_item_id and qty are required' });
  }

  try {
    const user = req.user!;
    const menuItemIdNum = Number(menu_item_id);
    const qtyNum = Number(qty);

    // Read the order's current head_event_id and verify ownership
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        restaurant_id: user.restaurant_id
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found or access denied' });
    }

    // Verify menu item belongs to user's restaurant
    const menuItem = await prisma.menuItem.findFirst({
      where: {
        id: menuItemIdNum,
        restaurant_id: user.restaurant_id
      }
    });

    if (!menuItem) {
      return res.status(404).json({ error: 'Menu item not found or access denied' });
    }

    // Client event metadata
    const eventId = req.body.event_id || crypto.randomUUID();
    const deviceId = req.body.device_id || 'rest-api';
    const hlc = req.body.hlc || `${Date.now()}-0-rest-api`;
    const clientCreatedAt = req.body.client_created_at || new Date();

    // Call writeEvent (Mongo) with based_on_event_id set to current head
    try {
      await writeEvent({
        event_id: eventId,
        restaurant_id: user.restaurant_id,
        order_id: orderId,
        table_id: order.table_id,
        device_id: deviceId,
        user_id: user.user_id,
        action: 'ADD_ITEM',
        payload: { menu_item_id: menuItemIdNum, qty: qtyNum, notes: notes || null },
        based_on_event_id: order.head_event_id,
        client_created_at: clientCreatedAt,
        hlc: hlc
      });
    } catch (err: any) {
      console.error('MongoDB writeEvent failed:', err);
      return res.status(500).json({ error: `Mongo event write failed: ${err.message}` });
    }

    // Wrap Postgres writes in a transaction
    let orderItem;
    try {
      orderItem = await prisma.$transaction(async (tx) => {
        const item = await tx.orderItem.create({
          data: {
            order_id: orderId,
            menu_item_id: menuItemIdNum,
            qty: qtyNum,
            status: OrderItemStatus.pending,
            notes: notes || null,
            created_by: user.user_id
          }
        });

        await tx.order.update({
          where: { id: orderId },
          data: { head_event_id: eventId }
        });

        return item;
      });
    } catch (err) {
      console.error(`FATAL: MongoDB writeEvent succeeded (Event ID: ${eventId}) but Postgres write failed!`, err);
      return res.status(500).json({ error: 'Postgres transaction failed' });
    }

    try {
      const fullOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { order_items: true }
      });
      if (fullOrder) {
        broadcastToTable(fullOrder.table_id, fullOrder);
      }
    } catch (broadcastErr) {
      console.error('Failed to broadcast order update:', broadcastErr);
    }

    return res.status(201).json(orderItem);
  } catch (error) {
    console.error('Add item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. PATCH /orders/:id/items/:itemId — update qty or status
app.patch('/orders/:id/items/:itemId', authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const { qty, status } = req.body;

  if (qty === undefined && status === undefined) {
    return res.status(400).json({ error: 'Either qty or status must be provided' });
  }

  try {
    const user = req.user!;

    // Read the order's current head_event_id and verify ownership
    const orderItem = await prisma.orderItem.findFirst({
      where: {
        id: itemId,
        order_id: orderId,
        order: {
          restaurant_id: user.restaurant_id
        }
      },
      include: {
        order: true
      }
    });

    if (!orderItem) {
      return res.status(404).json({ error: 'Order item not found or access denied' });
    }

    // Client event metadata
    const deviceId = req.body.device_id || 'rest-api';
    const hlc = req.body.hlc || `${Date.now()}-0-rest-api`;
    const clientCreatedAt = req.body.client_created_at || new Date();

    let lastEventId = orderItem.order.head_event_id;
    const dbUpdates: any = {};

    // 1. Write event for Qty change if provided
    if (qty !== undefined) {
      const qtyNum = Number(qty);
      const eventIdQty = qty !== undefined && status === undefined ? (req.body.event_id || crypto.randomUUID()) : crypto.randomUUID();
      try {
        await writeEvent({
          event_id: eventIdQty,
          restaurant_id: user.restaurant_id,
          order_id: orderId,
          table_id: orderItem.order.table_id,
          device_id: deviceId,
          user_id: user.user_id,
          action: 'UPDATE_ITEM_QTY',
          payload: { itemId, qty: qtyNum },
          based_on_event_id: lastEventId,
          client_created_at: clientCreatedAt,
          hlc: hlc
        });
      } catch (err: any) {
        console.error('MongoDB writeEvent failed for qty change:', err);
        return res.status(500).json({ error: `Mongo event write failed: ${err.message}` });
      }
      lastEventId = eventIdQty;
      dbUpdates.qty = qtyNum;
    }

    // 2. Write event for Status change if provided
    if (status !== undefined) {
      // Validate status enum
      if (!Object.values(OrderItemStatus).includes(status)) {
        return res.status(400).json({ error: `Invalid item status: ${status}` });
      }
      const eventIdStatus = status !== undefined && qty === undefined ? (req.body.event_id || crypto.randomUUID()) : crypto.randomUUID();
      try {
        await writeEvent({
          event_id: eventIdStatus,
          restaurant_id: user.restaurant_id,
          order_id: orderId,
          table_id: orderItem.order.table_id,
          device_id: deviceId,
          user_id: user.user_id,
          action: 'UPDATE_ITEM_STATUS',
          payload: { itemId, status },
          based_on_event_id: lastEventId,
          client_created_at: clientCreatedAt,
          hlc: hlc
        });
      } catch (err: any) {
        console.error('MongoDB writeEvent failed for status change:', err);
        return res.status(500).json({ error: `Mongo event write failed: ${err.message}` });
      }
      lastEventId = eventIdStatus;
      dbUpdates.status = status as OrderItemStatus;
    }

    // Wrap Postgres writes in a transaction
    let updatedItem;
    try {
      updatedItem = await prisma.$transaction(async (tx) => {
        const item = await tx.orderItem.update({
          where: { id: itemId },
          data: dbUpdates
        });

        await tx.order.update({
          where: { id: orderId },
          data: { head_event_id: lastEventId }
        });

        return item;
      });
    } catch (err) {
      console.error(`FATAL: MongoDB writeEvent succeeded (Last Event ID: ${lastEventId}) but Postgres write failed!`, err);
      return res.status(500).json({ error: 'Postgres transaction failed' });
    }

    try {
      const fullOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { order_items: true }
      });
      if (fullOrder) {
        broadcastToTable(fullOrder.table_id, fullOrder);
      }
    } catch (broadcastErr) {
      console.error('Failed to broadcast order update:', broadcastErr);
    }

    return res.json(updatedItem);
  } catch (error) {
    console.error('Update item error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. POST /orders/:id/cancel — cancel order
app.post('/orders/:id/cancel', authMiddleware, async (req, res) => {
  const orderId = Number(req.params.id);

  try {
    const user = req.user!;

    // Read the order's current head_event_id and verify ownership
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        restaurant_id: user.restaurant_id
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found or access denied' });
    }

    // Client event metadata
    const eventId = req.body.event_id || crypto.randomUUID();
    const deviceId = req.body.device_id || 'rest-api';
    const hlc = req.body.hlc || `${Date.now()}-0-rest-api`;
    const clientCreatedAt = req.body.client_created_at || new Date();

    // Call writeEvent (Mongo) with based_on_event_id set to current head
    try {
      await writeEvent({
        event_id: eventId,
        restaurant_id: user.restaurant_id,
        order_id: orderId,
        table_id: order.table_id,
        device_id: deviceId,
        user_id: user.user_id,
        action: 'CANCEL_ORDER',
        payload: { order_id: orderId },
        based_on_event_id: order.head_event_id,
        client_created_at: clientCreatedAt,
        hlc: hlc
      });
    } catch (err: any) {
      console.error('MongoDB writeEvent failed:', err);
      return res.status(500).json({ error: `Mongo event write failed: ${err.message}` });
    }

    // Wrap Postgres writes in a transaction
    try {
      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.cancelled,
            head_event_id: eventId
          }
        });

        await tx.orderItem.updateMany({
          where: { order_id: orderId },
          data: {
            status: OrderItemStatus.cancelled
          }
        });
      });
    } catch (err) {
      console.error(`FATAL: MongoDB writeEvent succeeded (Event ID: ${eventId}) but Postgres write failed!`, err);
      return res.status(500).json({ error: 'Postgres transaction failed' });
    }

    try {
      const fullOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { order_items: true }
      });
      if (fullOrder) {
        broadcastToTable(fullOrder.table_id, fullOrder);
      }
    } catch (broadcastErr) {
      console.error('Failed to broadcast order update:', broadcastErr);
    }

    return res.json({ message: 'Order successfully cancelled' });
  } catch (error) {
    console.error('Cancel order error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sync/pull — pull offline events since a given event_id
app.get('/sync/pull', authMiddleware, async (req, res) => {
  const { order_id, since } = req.query;
  if (!order_id) {
    return res.status(400).json({ error: 'order_id is required' });
  }

  try {
    const db = await connectMongo();
    let sinceEvent = null;

    if (since) {
      sinceEvent = await db.collection('events').findOne({ event_id: String(since) });
      if (!sinceEvent) {
        return res.status(404).json({ error: 'since event_id not found' });
      }
    }

    const query: any = { order_id: Number(order_id) };
    if (sinceEvent) {
      query.server_received_at = { $gt: sinceEvent.server_received_at };
    }

    const events = await db.collection('events')
      .find(query)
      .sort({ server_received_at: 1 })
      .toArray();

    return res.json(events);
  } catch (error) {
    console.error('Sync pull error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Helpers for sync conflict classification
function targetSameItem(e1: any, e2: any): boolean {
  const isOrderLevel = (action: string) => action === 'CANCEL_ORDER' || action === 'CREATE_ORDER';

  if (isOrderLevel(e1.action) || isOrderLevel(e2.action)) {
    return true; // Collides at order level
  }

  // If one of them is ADD_ITEM, it's a new item creation, so it doesn't target any existing item
  if (e1.action === 'ADD_ITEM' || e2.action === 'ADD_ITEM') {
    return false;
  }

  const e1ItemId = e1.payload?.itemId !== undefined ? e1.payload?.itemId : e1.payload?.item_id;
  const e2ItemId = e2.payload?.itemId !== undefined ? e2.payload?.itemId : e2.payload?.item_id;

  if (e1ItemId !== undefined && e2ItemId !== undefined) {
    return Number(e1ItemId) === Number(e2ItemId);
  }

  return false;
}

function isDestructive(e: any): boolean {
  if (e.action === 'CANCEL_ORDER' || e.action === 'REMOVE_ITEM') {
    return true;
  }
  if (e.action === 'UPDATE_ITEM_STATUS') {
    const status = e.payload?.status;
    if (status === 'cancelled' || status === 'served') {
      return true;
    }
  }
  return false;
}

function compareHLC(hlc1: string, hlc2: string): number {
  const parts1 = hlc1.split('-');
  const parts2 = hlc2.split('-');
  const t1 = Number(parts1[0]);
  const t2 = Number(parts2[0]);
  if (!isNaN(t1) && !isNaN(t2) && t1 !== t2) {
    return t1 - t2;
  }
  const c1 = Number(parts1[1]);
  const c2 = Number(parts2[1]);
  if (!isNaN(c1) && !isNaN(c2) && c1 !== c2) {
    return c1 - c2;
  }
  return hlc1.localeCompare(hlc2);
}

async function applyEventToTx(tx: any, event: any) {
  const orderId = Number(event.order_id);
  if (event.action === 'CREATE_ORDER') {
    await tx.order.create({
      data: {
        id: orderId,
        restaurant_id: Number(event.restaurant_id),
        table_id: Number(event.table_id),
        status: OrderStatus.open,
        created_by: Number(event.user_id),
        head_event_id: event.event_id
      }
    });
  } else if (event.action === 'ADD_ITEM') {
    await tx.orderItem.create({
      data: {
        order_id: orderId,
        menu_item_id: Number(event.payload.menu_item_id),
        qty: Number(event.payload.qty),
        status: OrderItemStatus.pending,
        notes: event.payload.notes || null,
        created_by: Number(event.user_id)
      }
    });
    await tx.order.update({
      where: { id: orderId },
      data: { head_event_id: event.event_id }
    });
  } else if (event.action === 'UPDATE_ITEM_QTY') {
    const itemId = event.payload?.itemId !== undefined ? event.payload?.itemId : event.payload?.item_id;
    await tx.orderItem.update({
      where: { id: Number(itemId) },
      data: { qty: Number(event.payload.qty) }
    });
    await tx.order.update({
      where: { id: orderId },
      data: { head_event_id: event.event_id }
    });
  } else if (event.action === 'UPDATE_ITEM_STATUS') {
    const itemId = event.payload?.itemId !== undefined ? event.payload?.itemId : event.payload?.item_id;
    await tx.orderItem.update({
      where: { id: Number(itemId) },
      data: { status: event.payload.status as OrderItemStatus }
    });
    await tx.order.update({
      where: { id: orderId },
      data: { head_event_id: event.event_id }
    });
  } else if (event.action === 'CANCEL_ORDER') {
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.cancelled,
        head_event_id: event.event_id
      }
    });
    await tx.orderItem.updateMany({
      where: { order_id: orderId },
      data: { status: OrderItemStatus.cancelled }
    });
  } else {
    // Fallback: advance head
    await tx.order.update({
      where: { id: orderId },
      data: { head_event_id: event.event_id }
    });
  }
}

// POST /sync/push — push client events with conflict classifier
app.post('/sync/push', authMiddleware, async (req, res) => {
  const { events } = req.body;
  if (!events || !Array.isArray(events)) {
    return res.status(400).json({ error: 'events array is required' });
  }

  try {
    const results: { event_id: string; status: 'applied' | 'hard_conflict' | 'soft_conflict' | 'skipped' | 'error'; message?: string }[] = [];
    const skippedOrderIds = new Set<number>();
    const db = await connectMongo();

    for (const event of events) {
      // Idempotency Check: check if event has already been processed and logged in MongoDB
      const existingEvent = await db.collection('events').findOne({ event_id: event.event_id });
      if (existingEvent) {
        results.push({
          event_id: event.event_id,
          status: existingEvent.sync_status as any,
          ...(existingEvent.sync_status === 'error' ? { message: 'Event already processed and recorded with error status. Please generate a new event_id to retry.' } : {})
        });
        continue;
      }

      const orderId = Number(event.order_id);

      if (skippedOrderIds.has(orderId)) {
        results.push({ event_id: event.event_id, status: 'skipped' });
        continue;
      }

      // Read fresh from Postgres before each event
      const order = await prisma.order.findUnique({
        where: { id: orderId }
      });

      const currentHead = order ? order.head_event_id : null;

      if (event.based_on_event_id === currentHead) {
        // Fast-forward apply
        try {
          await prisma.$transaction(async (tx) => {
            await applyEventToTx(tx, event);
          });

          await writeEvent({
            ...event,
            sync_status: 'applied'
          });

          const fullOrder = await prisma.order.findUnique({
            where: { id: orderId },
            include: { order_items: true }
          });
          if (fullOrder) {
            broadcastToTable(fullOrder.table_id, fullOrder);
          }

          results.push({ event_id: event.event_id, status: 'applied' });
        } catch (err: any) {
          console.error(`Postgres fast-forward write failed for event ${event.event_id}:`, err);
          skippedOrderIds.add(orderId);
          await writeEvent({
            ...event,
            sync_status: 'error'
          });
          results.push({ event_id: event.event_id, status: 'error', message: err.message });
        }
      } else {
        // Mismatch -> run the conflict classifier
        let basedOnTime: Date | null = null;
        if (event.based_on_event_id) {
          const basedOnEvent = await db.collection('events').findOne({ event_id: event.based_on_event_id });
          basedOnTime = basedOnEvent ? basedOnEvent.server_received_at : null;
        }

        let headTime = new Date();
        if (currentHead) {
          const headEvent = await db.collection('events').findOne({ event_id: currentHead });
          if (headEvent) {
            headTime = headEvent.server_received_at;
          }
        }

        // Intervening events are those successfully applied or soft resolved since basedOnTime up to headTime
        const query: any = {
          order_id: orderId,
          sync_status: { $in: ['applied', 'soft_conflict'] }
        };
        if (basedOnTime) {
          query.server_received_at = { $gt: basedOnTime, $lte: headTime };
        } else {
          query.server_received_at = { $lte: headTime };
        }

        const interveningEvents = await db.collection('events')
          .find(query)
          .sort({ server_received_at: 1 })
          .toArray();

        const collidingEvents = interveningEvents.filter(intervening => targetSameItem(event, intervening));

        if (collidingEvents.length === 0) {
          // AUTO_MERGE
          try {
            await prisma.$transaction(async (tx) => {
              await applyEventToTx(tx, event);
            });

            await writeEvent({
              ...event,
              sync_status: 'applied',
              resolution: {
                type: 'auto_merge',
                resolved_by: 'system',
                resolved_at: new Date(),
                chosen_event_id: event.event_id
              }
            });

            const fullOrder = await prisma.order.findUnique({
              where: { id: orderId },
              include: { order_items: true }
            });
            if (fullOrder) {
              broadcastToTable(fullOrder.table_id, fullOrder);
            }

            results.push({ event_id: event.event_id, status: 'applied' });
          } catch (err: any) {
            console.error(`Postgres auto-merge write failed for event ${event.event_id}:`, err);
            skippedOrderIds.add(orderId);
            await writeEvent({
              ...event,
              sync_status: 'error'
            });
            results.push({ event_id: event.event_id, status: 'error', message: err.message });
          }
        } else if (!isDestructive(event) && collidingEvents.every(e => !isDestructive(e))) {
          // SOFT_CONFLICT (non-destructive same item concurrent edit -> LWW resolution)
          let winningEvent = event;
          let incomingWins = true;
          const conflictingEventIds: string[] = [];

          for (const intervening of collidingEvents) {
            conflictingEventIds.push(intervening.event_id);
            if (compareHLC(intervening.hlc, winningEvent.hlc) > 0) {
              winningEvent = intervening;
              incomingWins = false;
            }
          }

          if (incomingWins) {
            try {
              await prisma.$transaction(async (tx) => {
                await applyEventToTx(tx, event);
              });

              await writeEvent({
                ...event,
                sync_status: 'soft_conflict',
                conflict_with: conflictingEventIds,
                resolution: {
                  type: 'provisional_lww',
                  resolved_by: 'system',
                  resolved_at: new Date(),
                  chosen_event_id: event.event_id
                }
              });

              // Mark losing intervening events as soft conflict in Mongo
              for (const losingId of conflictingEventIds) {
                await db.collection('events').updateOne(
                  { event_id: losingId },
                  {
                    $set: {
                      sync_status: 'soft_conflict',
                      resolution: {
                        type: 'provisional_lww',
                        resolved_by: 'system',
                        resolved_at: new Date(),
                        chosen_event_id: event.event_id
                      }
                    },
                    $addToSet: { conflict_with: event.event_id }
                  }
                );
              }

              const fullOrder = await prisma.order.findUnique({
                where: { id: orderId },
                include: { order_items: true }
              });
              if (fullOrder) {
                broadcastToTable(fullOrder.table_id, fullOrder);
              }

              results.push({ event_id: event.event_id, status: 'soft_conflict' });
            } catch (err: any) {
              console.error(`Postgres LWW incoming write failed for event ${event.event_id}:`, err);
              skippedOrderIds.add(orderId);
              await writeEvent({
                ...event,
                sync_status: 'error'
              });
              results.push({ event_id: event.event_id, status: 'error', message: err.message });
            }
          } else {
            // Intervening event won HLC tie-breaker
            try {
              await prisma.order.update({
                where: { id: orderId },
                data: { head_event_id: winningEvent.event_id }
              });

              await writeEvent({
                ...event,
                sync_status: 'soft_conflict',
                conflict_with: conflictingEventIds,
                resolution: {
                  type: 'provisional_lww',
                  resolved_by: 'system',
                  resolved_at: new Date(),
                  chosen_event_id: winningEvent.event_id
                }
              });

              // Mark winning intervening event as soft conflict in Mongo
              await db.collection('events').updateOne(
                { event_id: winningEvent.event_id },
                {
                  $set: {
                    sync_status: 'soft_conflict',
                    resolution: {
                      type: 'provisional_lww',
                      resolved_by: 'system',
                      resolved_at: new Date(),
                      chosen_event_id: winningEvent.event_id
                    }
                  },
                  $addToSet: { conflict_with: event.event_id }
                }
              );

              const fullOrder = await prisma.order.findUnique({
                where: { id: orderId },
                include: { order_items: true }
              });
              if (fullOrder) {
                broadcastToTable(fullOrder.table_id, fullOrder);
              }

              results.push({ event_id: event.event_id, status: 'soft_conflict' });
            } catch (err: any) {
              console.error(`Postgres LWW intervening write failed for event ${event.event_id}:`, err);
              skippedOrderIds.add(orderId);
              await writeEvent({
                ...event,
                sync_status: 'error'
              });
              results.push({ event_id: event.event_id, status: 'error', message: err.message });
            }
          }
        } else {
          // HARD_CONFLICT
          skippedOrderIds.add(orderId);
          const conflictingEventIds = collidingEvents.map(e => e.event_id);

          await writeEvent({
            ...event,
            sync_status: 'hard_conflict',
            conflict_with: conflictingEventIds,
            resolution: null
          });

          for (const colId of conflictingEventIds) {
            await db.collection('events').updateOne(
              { event_id: colId },
              {
                $addToSet: { conflict_with: event.event_id }
              }
            );
          }

          results.push({ event_id: event.event_id, status: 'hard_conflict' });
        }
      }
    }

    return res.json(results);
  } catch (error) {
    console.error('Sync push error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /sync/resolve — manually resolve hard conflicts
app.post('/sync/resolve', authMiddleware, async (req, res) => {
  const { event_id, action } = req.body;
  if (!event_id || !action || (action !== 'accept' && action !== 'reject')) {
    return res.status(400).json({ error: 'event_id and action ("accept" or "reject") are required' });
  }

  try {
    const db = await connectMongo();
    const event = await db.collection('events').findOne({ event_id: String(event_id) });
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (event.sync_status !== 'hard_conflict') {
      return res.status(400).json({ error: 'Event is not in hard_conflict status' });
    }

    const orderId = Number(event.order_id);
    const user = req.user!;

    if (action === 'accept') {
      try {
        await prisma.$transaction(async (tx) => {
          await applyEventToTx(tx, event);
        });
      } catch (err: any) {
        console.error(`Postgres manual resolution write failed for event ${event_id}:`, err);
        return res.status(500).json({ error: `Postgres resolution write failed: ${err.message}` });
      }

      const now = new Date();
      await db.collection('events').updateOne(
        { event_id },
        {
          $set: {
            sync_status: 'applied',
            resolution: {
              type: 'manual',
              resolved_by: String(user.user_id),
              resolved_at: now,
              chosen_event_id: event_id
            }
          }
        }
      );

      if (event.conflict_with && Array.isArray(event.conflict_with)) {
        for (const colId of event.conflict_with) {
          await db.collection('events').updateOne(
            { event_id: colId },
            {
              $set: {
                resolution: {
                  type: 'manual',
                  resolved_by: String(user.user_id),
                  resolved_at: now,
                  chosen_event_id: event_id
                }
              }
            }
          );
        }
      }
    } else {
      // Reject
      const now = new Date();
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      const currentHead = order ? order.head_event_id : null;

      await db.collection('events').updateOne(
        { event_id },
        {
          $set: {
            sync_status: 'rejected',
            resolution: {
              type: 'manual',
              resolved_by: String(user.user_id),
              resolved_at: now,
              chosen_event_id: currentHead || event_id
            }
          }
        }
      );

      if (event.conflict_with && Array.isArray(event.conflict_with)) {
        for (const colId of event.conflict_with) {
          await db.collection('events').updateOne(
            { event_id: colId },
            {
              $set: {
                resolution: {
                  type: 'manual',
                  resolved_by: String(user.user_id),
                  resolved_at: now,
                  chosen_event_id: currentHead || event_id
                }
              }
            }
          );
        }
      }
    }

    const fullOrder = await prisma.order.findUnique({
      where: { id: orderId },
      include: { order_items: true }
    });
    if (fullOrder) {
      broadcastToTable(fullOrder.table_id, fullOrder);
    }

    return res.json({ message: `Event successfully resolved with action: ${action}` });
  } catch (error) {
    console.error('Resolve error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /tables — retrieve all tables with their active order
app.get('/tables', authMiddleware, async (req, res) => {
  try {
    const user = req.user!;
    const tables = await prisma.table.findMany({
      where: { restaurant_id: user.restaurant_id },
      include: {
        orders: {
          where: {
            status: {
              in: [OrderStatus.open, OrderStatus.sent, OrderStatus.preparing, OrderStatus.ready, OrderStatus.served]
            }
          },
          orderBy: { created_at: 'desc' },
          take: 1
        }
      },
      orderBy: { number: 'asc' }
    });

    const results = tables.map(t => ({
      id: t.id,
      restaurant_id: t.restaurant_id,
      number: t.number,
      status: t.status,
      active_order: t.orders[0] || null
    }));

    return res.json(results);
  } catch (error) {
    console.error('Get tables error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /orders/:id — retrieve full order details with items
app.get('/orders/:id', authMiddleware, async (req, res) => {
  try {
    const user = req.user!;
    const orderId = Number(req.params.id);
    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        restaurant_id: user.restaurant_id
      },
      include: {
        order_items: {
          include: {
            menu_item: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    return res.json(order);
  } catch (error) {
    console.error('Get order error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /menu — retrieve available menu items
app.get('/menu', authMiddleware, async (req, res) => {
  try {
    const user = req.user!;
    const menuItems = await prisma.menuItem.findMany({
      where: {
        restaurant_id: user.restaurant_id,
        is_available: true
      },
      orderBy: { name: 'asc' }
    });
    return res.json(menuItems);
  } catch (error) {
    console.error('Get menu error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /events/order/:id — retrieve all raw Mongo events for an order
app.get('/events/order/:id', authMiddleware, async (req, res) => {
  try {
    const user = req.user!;
    const orderId = Number(req.params.id);

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        restaurant_id: user.restaurant_id
      }
    });
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const db = await connectMongo();
    const events = await db.collection('events')
      .find({ order_id: orderId })
      .sort({ server_received_at: 1 })
      .toArray();

    return res.json(events);
  } catch (error) {
    console.error('Get order events error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sync/conflicts — retrieve all unresolved hard conflicts for the restaurant
app.get('/sync/conflicts', authMiddleware, async (req, res) => {
  try {
    const user = req.user!;
    if (user.role !== UserRole.manager && user.role !== UserRole.admin) {
      return res.status(403).json({ error: 'Forbidden: manager/admin role only' });
    }

    const db = await connectMongo();
    const conflicts = await db.collection('events')
      .find({
        restaurant_id: user.restaurant_id,
        sync_status: 'hard_conflict',
        resolution: null
      })
      .sort({ server_received_at: 1 })
      .toArray();

    return res.json(conflicts);
  } catch (error) {
    console.error('Get conflicts error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /kitchen/items — retrieve all preparation items for the kitchen
app.get('/kitchen/items', authMiddleware, async (req, res) => {
  try {
    const user = req.user!;
    if (user.role !== UserRole.kitchen && user.role !== UserRole.manager && user.role !== UserRole.admin) {
      return res.status(403).json({ error: 'Forbidden: kitchen role only' });
    }

    const items = await prisma.orderItem.findMany({
      where: {
        status: {
          in: [OrderItemStatus.sent_to_kitchen, OrderItemStatus.preparing]
        },
        order: {
          restaurant_id: user.restaurant_id
        }
      },
      include: {
        menu_item: true,
        order: {
          include: {
            table: true
          }
        }
      },
      orderBy: { updated_at: 'asc' }
    });

    return res.json(items);
  } catch (error) {
    console.error('Get kitchen items error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
export { app };
