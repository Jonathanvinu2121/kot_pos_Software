import { MongoClient, Db } from 'mongodb';

const mongoUrl = process.env.MONGO_URL;

if (!mongoUrl) {
  throw new Error('MONGO_URL environment variable is not defined.');
}

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(mongoUrl as string);
  await client.connect();
  db = client.db();
  // Ensure unique index on event_id
  await db.collection('events').createIndex({ event_id: 1 }, { unique: true });
  return db;
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
