import { useEffect } from 'react';

export function usePageLifecycle({ isSessionActive, sessionId, sessionType, logBufferRef }) {
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isSessionActive && sessionId) {
        e.preventDefault();
        e.returnValue = 'You have an active therapy session. Leaving will end your session.';
        return e.returnValue;
      }
    };

    const handlePageHide = () => {
      // Flush logs regardless of session state
      const logBlob = new Blob([JSON.stringify({ records: logBufferRef.current })], { type: 'application/json' });
      navigator.sendBeacon?.("/logs/batch", logBlob);

      // If session is active, end it
      if (isSessionActive && sessionId) {
        const endBlob = new Blob([JSON.stringify({ sessionId })], { type: 'application/json' });
        if (sessionType === 'chat') {
          navigator.sendBeacon?.("/api/chat/end", endBlob);
        } else {
          navigator.sendBeacon?.(`/api/sessions/${sessionId}/end`, endBlob);
        }
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [isSessionActive, sessionId, sessionType]);
}
