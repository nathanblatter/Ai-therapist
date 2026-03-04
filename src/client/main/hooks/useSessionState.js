import { useRef, useState } from 'react';

export function useSessionState() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [messages, setMessages] = useState([]);
  const [assistantStream, setAssistantStream] = useState("");
  const [localStream, setLocalStream] = useState(null);
  const assistantBuffer = useRef("");
  const userBuffer = useRef("");
  const currentVoiceMessageId = useRef(null);
  const dataChannelRef = useRef(null);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);
  const [sessionId, setSessionId] = useState(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const socketRef = useRef(null);
  const [sessionType, setSessionType] = useState(null); // 'realtime' or 'chat'

  function resetSession() {
    setIsSessionActive(false);
    setSessionId(null);
    setSessionType(null);
    dataChannelRef.current = null;
    setLocalStream(null);
    peerConnection.current = null;
  }

  return {
    isSessionActive, setIsSessionActive,
    events, setEvents,
    messages, setMessages,
    assistantStream, setAssistantStream,
    localStream, setLocalStream,
    assistantBuffer,
    userBuffer,
    currentVoiceMessageId,
    dataChannelRef,
    peerConnection,
    audioElement,
    sessionId, setSessionId,
    isSettingsOpen, setIsSettingsOpen,
    socketRef,
    sessionType, setSessionType,
    resetSession
  };
}
