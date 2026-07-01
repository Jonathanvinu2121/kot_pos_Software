import { connectMongo } from '../db/mongodb';

export interface MongoEvent {
  event_id: string;
  restaurant_id: number;
  order_id: number;
  table_id: number;
  device_id: string;
  user_id: number;
  action: 'CREATE_ORDER' | 'ADD_ITEM' | 'UPDATE_ITEM_QTY' | 'UPDATE_ITEM_STATUS' | 'REMOVE_ITEM' | 'CANCEL_ORDER' | string;
  payload: any;
  based_on_event_id: string | null;
  client_created_at: Date;
  hlc: string;
  server_received_at: Date;
  sync_status: 'applied' | 'soft_conflict' | 'hard_conflict' | 'rejected' | 'error';
  conflict_with: string[];
  resolution: {
    type: 'auto_merge' | 'provisional_lww' | 'manual';
    resolved_by: string;
    resolved_at: Date;
    chosen_event_id: string;
  } | null;
}

export async function writeEvent(eventData: Partial<MongoEvent>): Promise<MongoEvent> {
  const requiredFields: (keyof MongoEvent)[] = [
    'event_id',
    'restaurant_id',
    'order_id',
    'table_id',
    'device_id',
    'user_id',
    'action',
    'payload',
    'client_created_at',
    'hlc'
  ];

  for (const field of requiredFields) {
    if (eventData[field] === undefined || eventData[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Parse client_created_at to Date if passed as a string or number
  let clientCreatedAt: Date;
  if (eventData.client_created_at instanceof Date) {
    clientCreatedAt = eventData.client_created_at;
  } else {
    clientCreatedAt = new Date(eventData.client_created_at as any);
    if (isNaN(clientCreatedAt.getTime())) {
      throw new Error('Invalid client_created_at date format');
    }
  }

  const db = await connectMongo();

  const finalEvent: MongoEvent = {
    event_id: eventData.event_id!,
    restaurant_id: Number(eventData.restaurant_id),
    order_id: Number(eventData.order_id),
    table_id: Number(eventData.table_id),
    device_id: String(eventData.device_id),
    user_id: Number(eventData.user_id),
    action: String(eventData.action),
    payload: eventData.payload,
    based_on_event_id: eventData.based_on_event_id !== undefined ? eventData.based_on_event_id : null,
    client_created_at: clientCreatedAt,
    hlc: String(eventData.hlc),
    server_received_at: new Date(),
    sync_status: eventData.sync_status || 'applied',
    conflict_with: eventData.conflict_with || [],
    resolution: eventData.resolution !== undefined ? eventData.resolution : null
  };

  await db.collection('events').insertOne(finalEvent);
  return finalEvent;
}
