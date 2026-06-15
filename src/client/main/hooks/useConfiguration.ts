import { useEffect, useState } from 'react';
import { initializeLogger } from '../utils/logger';

export function useConfiguration() {
  const [isClient, setIsClient] = useState(false);
  const [crisisContact, setCrisisContact] = useState({
    hotline: 'BYU Counseling and Psychological Services',
    phone: '(801) 422-3035',
    text: 'HELLO to 741741',
    enabled: true
  });
  const [features, setFeatures] = useState({
    output_modalities: ["audio"],
    voice_enabled: true,
    chat_enabled: true
  });
  const [sessionSettings, setSessionSettings] = useState({
    voice: 'cedar',
    language: 'en'
  });

  useEffect(() => {
    setIsClient(true);

    // Initialize logger first (controls console.log output)
    initializeLogger();

    // Fetch crisis contact info
    fetch('/api/config/crisis')
      .then(res => res.json())
      .then(data => setCrisisContact(data))
      .catch(err => console.error('Failed to fetch crisis contact:', err));

    // Fetch features config
    fetch('/api/config/features')
      .then(res => res.json())
      .then(data => setFeatures(data))
      .catch(err => console.error('Failed to fetch features config:', err));

    // Fetch user preferences (voice and language)
    fetch('/api/users/preferences', {
      credentials: 'include'
    })
      .then(res => {
        if (res.ok) {
          return res.json();
        }
        // If not authenticated or error, use defaults
        return { voice: 'cedar', language: 'en' };
      })
      .then(prefs => {
        setSessionSettings({
          voice: prefs.voice || 'cedar',
          language: prefs.language || 'en'
        });
        console.log('Loaded user preferences:', prefs);
      })
      .catch(err => {
        console.error('Failed to fetch user preferences:', err);
        // Keep defaults on error
      });
  }, []);

  return {
    isClient,
    crisisContact,
    features,
    sessionSettings,
    setSessionSettings
  };
}
