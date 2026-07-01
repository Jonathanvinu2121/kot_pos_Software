import * as dotenv from 'dotenv';
dotenv.config();

import { io } from 'socket.io-client';
import * as jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET || 'supersecret_pos_key';
const token = jwt.sign(
  {
    restaurant_id: 1,
    role: 'waiter',
    user_id: 1
  },
  secret,
  { expiresIn: '1d' }
);

console.log(`[${new Date().toISOString()}] Generated test JWT Token:`, token);

const socket = io('http://localhost:3000', {
  auth: {
    token: `Bearer ${token}`
  }
});

socket.on('connect', () => {
  console.log(`[${new Date().toISOString()}] Connected to Socket.io server. Socket ID: ${socket.id}`);
  
  // Join room for Table 1
  socket.emit('join_table', { table_id: 1 });
  console.log(`[${new Date().toISOString()}] Emitted join_table for table_id: 1`);
});

socket.on('connect_error', (err) => {
  console.error(`[${new Date().toISOString()}] Connection error:`, err.message);
});

socket.on('disconnect', (reason) => {
  console.log(`[${new Date().toISOString()}] Disconnected from server. Reason: ${reason}`);
});

socket.on('order:updated', (payload) => {
  console.log(`\n[${new Date().toISOString()}] RECEIVED order:updated EVENT!`);
  console.log(JSON.stringify(payload, null, 2));
});

console.log(`[${new Date().toISOString()}] Socket.io test client initialized. Waiting for events...`);
