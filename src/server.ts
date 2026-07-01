import * as dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { app } from './app';
import { connectMongo } from './db/mongodb';
import { initSocket } from './services/socket';

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    // Initialize MongoDB Connection before starting Express
    await connectMongo();
    console.log('Connected to MongoDB successfully.');

    const httpServer = createServer(app);
    initSocket(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
