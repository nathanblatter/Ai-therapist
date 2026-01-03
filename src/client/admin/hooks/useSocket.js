import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

let socketInstance = null;

export function useSocket() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!socketInstance) {
      socketInstance = io({
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      socketInstance.on('connect', () => {
        console.log('✅ Socket.io connected');
        setConnected(true);
      });

      socketInstance.on('disconnect', () => {
        console.warn('⚠️ Socket.io disconnected');
        setConnected(false);
      });

      socketInstance.on('connect_error', (error) => {
        console.error('❌ Socket.io connection error:', error.message);
      });

      socketInstance.on('reconnect', (attemptNumber) => {
        console.log(`✅ Socket.io reconnected after ${attemptNumber} attempts`);
      });
    }

    setSocket(socketInstance);

    return () => {
      // Keep connection alive across component unmounts
    };
  }, []);

  return { socket, connected };
}

export function disconnectSocket() {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
  }
}
