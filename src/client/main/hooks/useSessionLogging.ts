import { useRef } from 'react';

const FLUSH_SIZE = 200;
const FLUSH_INTERVAL_MS = 15000;

interface LogRecord {
  timestamp: string;
  sessionId: string | null;
  role: string;
  type: string;
  message: string | null;
  extras: unknown;
}

interface LogConversationParams {
  sessionId: string | null;
  role: string;
  type: string;
  message: string;
  extras?: unknown;
}

export function useSessionLogging() {
  const logBufferRef = useRef<LogRecord[]>([]);
  const flushInFlightRef = useRef<boolean>(false);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function logConversation({ sessionId, role, type, message, extras }: LogConversationParams) {
    if (!sessionId || !type) return;
    logBufferRef.current.push({
      timestamp: new Date().toISOString(),
      sessionId,
      role: role || "system",
      type,
      message: message ?? null,
      extras: extras ?? null,
    });
    if (logBufferRef.current.length >= FLUSH_SIZE) void flushLogs();
  }

  async function flushLogs() {
    if (flushInFlightRef.current) return;
    const batch = logBufferRef.current;
    if (!batch.length) return;
    flushInFlightRef.current = true;
    logBufferRef.current = [];
    try {
      await fetch("/logs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: batch }),
        keepalive: true,
      });
    } catch (err) {
      console.error("Failed to batch log, re-queueing:", err);
      logBufferRef.current = [...batch, ...logBufferRef.current];
    } finally {
      flushInFlightRef.current = false;
    }
  }

  function startPeriodicFlush() {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setInterval(() => void flushLogs(), FLUSH_INTERVAL_MS);
  }

  function stopPeriodicFlush() {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }

  return {
    logBufferRef,
    logConversation,
    flushLogs,
    startPeriodicFlush,
    stopPeriodicFlush
  };
}
