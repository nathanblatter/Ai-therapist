import { io } from 'socket.io-client';
import { toast } from '../../shared/components/Toast';

export function useChatSession({
  sessionId, setSessionId,
  setSessionType,
  setIsSessionActive,
  setMessages,
  socketRef,
  setSessionEndTime, setTimeRemaining,
  sessionSettings,
  getPreambleForLanguage
}) {

  async function startSession() {
    try {
      const response = await fetch('/api/chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (response.status === 429) {
        const errorData = await response.json();
        toast.error(errorData.message || "You have reached your session limit. Please try again later.");
        console.warn("Rate limit exceeded:", errorData);
        return;
      }

      const data = await response.json();
      console.log("Chat session started:", data);

      if (data.alreadyActive) {
        toast.warning("You already have an active session. Please end it before starting a new one.");
        console.warn("Active session already exists:", data.sessionId);
        return;
      }

      const newSessionId = data.sessionId;
      setSessionId(newSessionId);
      setSessionType('chat');
      setIsSessionActive(true);

      // Connect to Socket.io
      const socket = io({ transports: ['websocket', 'polling'], reconnection: true });

      socket.on('connect', () => {
        console.log('Socket.io connected for chat session monitoring');
        socket.emit('session:join', { sessionId: newSessionId });
      });

      socket.on('session:status', (data) => {
        console.log('Received session:status event:', data);
        if (data.status === 'ended' && data.remoteTermination) {
          toast.warning(`Your session has been remotely ended by ${data.endedBy}. The session will now close.`);
          stopSession();
        }
      });

      socket.on('disconnect', () => {
        console.log('Socket.io disconnected');
      });

      socketRef.current = socket;

      // Add preamble message
      setMessages([{
        id: crypto.randomUUID(),
        role: "assistant",
        text: getPreambleForLanguage(sessionSettings.language, false),
      }]);

      console.log(`Chat-only session started: ${newSessionId}`);

    } catch (error) {
      console.error('Failed to start chat session:', error);
      toast.error('Failed to start chat session. Please try again.');
    }
  }

  async function stopSession() {
    if (sessionId) {
      try {
        await fetch('/api/chat/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
      } catch (error) {
        console.error('Failed to end chat session:', error);
      }
    }

    if (socketRef.current) {
      if (sessionId) {
        socketRef.current.emit('session:leave', { sessionId });
      }
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    setIsSessionActive(false);
    setSessionId(null);
    setSessionType(null);
    setSessionEndTime(null);
    setTimeRemaining(null);
  }

  async function sendMessage(message) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text: message },
    ]);

    try {
      const response = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message })
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const data = await response.json();

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", text: data.response },
      ]);

    } catch (error) {
      console.error('Failed to send chat message:', error);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "system", text: "Error: Failed to send message. Please try again." },
      ]);
    }
  }

  return {
    startSession,
    stopSession,
    sendMessage
  };
}
