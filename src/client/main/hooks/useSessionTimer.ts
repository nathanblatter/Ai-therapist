import { useEffect, useRef, useState, Dispatch, SetStateAction } from 'react';
import { toast } from '../../shared/components/Toast';

interface UseSessionTimerParams {
  isSessionActive: boolean;
  onTimeExpired: () => void;
}

export function useSessionTimer({ isSessionActive, onTimeExpired }: UseSessionTimerParams) {
  const [sessionEndTime, setSessionEndTime] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!sessionEndTime || !isSessionActive) {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      setTimeRemaining(null);
      return;
    }

    timerIntervalRef.current = setInterval(() => {
      const remaining = sessionEndTime - Date.now();

      if (remaining <= 0) {
        setTimeRemaining(0);
        clearInterval(timerIntervalRef.current!);
        timerIntervalRef.current = null;

        toast.warning("Your session time has ended. The session will now close.");
        onTimeExpired();
      } else {
        setTimeRemaining(remaining);
      }
    }, 1000);

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [sessionEndTime, isSessionActive]);

  return {
    sessionEndTime,
    setSessionEndTime,
    timeRemaining,
    setTimeRemaining
  };
}
