import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

let socketInstance: Socket | null = null;

function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io({
      withCredentials: true,
      // Polling-first, matching the participant sockets (participantSocket.ts /
      // userSocket.ts): a websocket-first handshake can be silently dropped by
      // some tunnel/proxy paths (no connect, no connect_error), leaving the
      // dashboard permanently disconnected. Engine.io upgrades to websocket
      // after the polling handshake succeeds.
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // The dashboard socket lives for the whole admin visit. The old finite
      // cap (5) meant one bad minute of network permanently killed live
      // monitoring/crisis events until a full page reload.
      reconnectionAttempts: Infinity
    });

    socketInstance.on('connect', () => {
      console.log('Socket.io connected');
    });

    socketInstance.on('disconnect', () => {
      console.warn('Socket.io disconnected');
    });

    socketInstance.on('connect_error', (error) => {
      console.error('Socket.io connection error:', error.message);
    });

    socketInstance.io.on('reconnect', (attemptNumber) => {
      console.log(`Socket.io reconnected after ${attemptNumber} attempts`);
    });
  }
  return socketInstance;
}

export function useSocket() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const s = getSocket();

    // Per-hook connect/disconnect listeners: the old module-level listeners
    // captured only the FIRST mounting component's setConnected, so every
    // later consumer (and any remount) kept a frozen `connected` value and the
    // first consumer got setState-after-unmount calls.
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);

    setConnected(s.connected);
    setSocket(s);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      // Keep the shared connection alive across component unmounts.
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
