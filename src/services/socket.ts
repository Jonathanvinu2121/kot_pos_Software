import { Server } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { UserPayload } from '../middleware/auth';

let io: Server | null = null;

export function initSocket(server: any): Server {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // Authentication middleware
  io.use((socket, next) => {
    // Check both auth object and query params for the token
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication error: Missing token'));
    }

    let actualToken = token;
    if (actualToken.startsWith('Bearer ')) {
      actualToken = actualToken.substring(7);
    }

    try {
      const secret = process.env.JWT_SECRET || 'supersecret_pos_key';
      const decoded = jwt.verify(actualToken, secret) as UserPayload;
      socket.data.user = decoded;
      next();
    } catch (err) {
      return next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket client connected: ${socket.id}`);

    const user = socket.data.user;
    if (user && (user.role === 'kitchen' || user.role === 'manager' || user.role === 'admin')) {
      socket.join('kitchen');
      console.log(`Socket ${socket.id} joined kitchen room based on role: ${user.role}`);
    }

    socket.on('join_table', (data: { table_id: number | string }) => {
      const tableId = data?.table_id;
      if (tableId !== undefined && tableId !== null) {
        const roomName = `table:${tableId}`;
        socket.join(roomName);
        console.log(`Socket ${socket.id} joined room ${roomName}`);
      }
    });

    socket.on('join_kitchen', () => {
      socket.join('kitchen');
      console.log(`Socket ${socket.id} joined room kitchen manually`);
    });

    socket.on('disconnect', () => {
      console.log(`Socket client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.io has not been initialized');
  }
  return io;
}

export function broadcastToTable(tableId: number, orderState: any) {
  try {
    const socketIO = getIO();
    const roomName = `table:${tableId}`;
    socketIO.to(roomName).emit('order:updated', orderState);
    socketIO.to('kitchen').emit('order:updated', orderState);
    console.log(`Broadcasted order:updated to room ${roomName} and kitchen`);
  } catch (error) {
    console.error('Failed to broadcast order update:', error);
  }
}
