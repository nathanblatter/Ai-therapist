import { useEffect, useRef, useState } from 'react';
import { X, Volume2, Square } from 'react-feather';

export default function SessionSettings({ isOpen, onClose, settings, onSettingsChange, disabled }) {
  const audioRef = useRef(null);
  const [availableVoices, setAvailableVoices] = useState([]);
  const [availableLanguages, setAvailableLanguages] = useState([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [playingVoice, setPlayingVoice] = useState(null);

  // Load available voices and languages when modal opens
  useEffect(() => {
    if (!isOpen) return;

    const fetchOptions = async () => {
      setLoadingOptions(true);
      try {
        const [voicesRes, languagesRes] = await Promise.all([
          fetch('/api/config/voices', { credentials: 'include' }),
          fetch('/api/config/languages', { credentials: 'include' })
        ]);

        if (voicesRes.ok) {
          const data = await voicesRes.json();
          setAvailableVoices(data.voices || []);
        }

        if (languagesRes.ok) {
          const data = await languagesRes.json();
          setAvailableLanguages(data.languages || []);
        }
      } catch (err) {
        console.error('Failed to fetch voice/language options:', err);
        setAvailableVoices([{ value: 'cedar', label: 'Cedar', description: 'Warm & natural' }]);
        setAvailableLanguages([{ value: 'en', label: 'English', description: 'English' }]);
      } finally {
        setLoadingOptions(false);
      }
    };

    fetchOptions();
  }, [isOpen]);

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Cleanup audio when modal closes
  useEffect(() => {
    if (!isOpen && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      setPlayingVoice(null);
    }
  }, [isOpen]);

  // Save user preferences to server
  const savePreferences = async (newSettings) => {
    try {
      const response = await fetch('/api/users/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: newSettings.voice,
          language: newSettings.language
        }),
        credentials: 'include'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to save preferences - HTTP', response.status, errorData);
        return;
      }

      console.log('Saved user preferences:', newSettings);
    } catch (err) {
      console.error('Failed to save preferences:', err);
    }
  };

  // Handle voice selection
  const handleVoiceSelect = (voiceValue) => {
    if (disabled) return;
    const newSettings = { ...settings, voice: voiceValue };
    onSettingsChange(newSettings);
    savePreferences(newSettings);
  };

  // Handle language selection
  const handleLanguageChange = (e) => {
    const newSettings = { ...settings, language: e.target.value };
    onSettingsChange(newSettings);
    savePreferences(newSettings);
  };

  // Handle voice preview playback
  const handlePlayPreview = (voiceValue) => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    // Toggle if same voice is playing
    if (playingVoice === voiceValue) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlayingVoice(null);
      return;
    }

    // Stop current audio and play new preview
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    audioRef.current.src = `/api/voices/preview/${voiceValue}`;
    audioRef.current.play()
      .then(() => setPlayingVoice(voiceValue))
      .catch((err) => {
        console.error('Failed to play voice preview:', err);
        setPlayingVoice(null);
      });

    audioRef.current.onended = () => setPlayingVoice(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-40 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl overflow-hidden animate-fadeIn">
          {/* Header */}
          <header className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 id="settings-modal-title" className="text-lg font-semibold text-gray-800">
              Session Settings
            </h2>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded-full transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Close settings"
            >
              <X size={20} className="text-gray-500" />
            </button>
          </header>

          {/* Content */}
          <div className="px-6 py-6">
            <div className="grid grid-cols-3 gap-6">
              {/* Voice Selection - takes 2 columns */}
              <div className="col-span-2">
                <VoiceSelector
                  voices={availableVoices}
                  selectedVoice={settings.voice}
                  playingVoice={playingVoice}
                  onSelect={handleVoiceSelect}
                  onPlayPreview={handlePlayPreview}
                  loading={loadingOptions}
                  disabled={disabled}
                />
              </div>

              {/* Language Selection - takes 1 column */}
              <div className="col-span-1">
                <LanguageSelector
                  languages={availableLanguages}
                  selectedLanguage={settings.language}
                  onChange={handleLanguageChange}
                  loading={loadingOptions}
                  disabled={disabled}
                />
              </div>
            </div>

            {/* Info Message */}
            {disabled && (
              <div className="mt-6 pt-4 border-t border-gray-100" role="status" aria-live="polite">
                <p className="text-xs text-gray-500">
                  End current session to change settings
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <footer className="px-6 py-4 bg-gray-50 border-t border-gray-100">
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-900 text-white text-sm font-medium rounded-lg transition-colors min-h-[44px]"
              aria-label="Close settings and return to session"
            >
              Done
            </button>
          </footer>
        </div>
      </div>
    </>
  );
}

// Voice Selector Component
function VoiceSelector({ voices, selectedVoice, playingVoice, onSelect, onPlayPreview, loading, disabled }) {
  if (loading) {
    return (
      <div className="space-y-2">
        <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
          Voice
        </label>
        <div className="text-sm text-gray-500">Loading voices...</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
        Voice
      </label>
      <div className="grid grid-cols-2 gap-2">
        {voices.map((voice) => (
          <VoiceOption
            key={voice.value}
            voice={voice}
            isSelected={selectedVoice === voice.value}
            isPlaying={playingVoice === voice.value}
            onSelect={() => onSelect(voice.value)}
            onPlayPreview={(e) => {
              e.stopPropagation();
              onPlayPreview(voice.value);
            }}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

// Voice Option Component
function VoiceOption({ voice, isSelected, isPlaying, onSelect, onPlayPreview, disabled }) {
  const containerClasses = [
    'flex items-center gap-3 p-3 rounded-lg border-2 transition-all',
    isSelected ? 'border-gray-800 bg-gray-50' : 'border-gray-200 bg-white hover:border-gray-300',
    disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
  ].join(' ');

  return (
    <div className={containerClasses} onClick={onSelect}>
      <input
        type="radio"
        name="voice"
        value={voice.value}
        checked={isSelected}
        onChange={() => {}}
        disabled={disabled}
        className="w-4 h-4 text-gray-800 border-gray-300 focus:ring-gray-800"
      />
      <div className="flex-1">
        <div className="font-medium text-sm text-gray-800">{voice.label}</div>
        <div className="text-xs text-gray-500">{voice.description}</div>
      </div>
      <button
        onClick={onPlayPreview}
        disabled={disabled}
        className="p-2 hover:bg-gray-100 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label={isPlaying ? `Stop ${voice.label} preview` : `Play ${voice.label} preview`}
        title={isPlaying ? 'Stop preview' : 'Play preview'}
      >
        {isPlaying ? (
          <Square size={18} className="text-gray-700" fill="currentColor" />
        ) : (
          <Volume2 size={18} className="text-gray-700" />
        )}
      </button>
    </div>
  );
}

// Language Selector Component
function LanguageSelector({ languages, selectedLanguage, onChange, loading, disabled }) {
  const selectClasses = [
    'w-full px-3 py-2.5 bg-white border border-gray-200 rounded-lg text-sm',
    'focus:outline-none focus:border-gray-400 focus:ring-0 transition-colors',
    'disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed',
    'appearance-none cursor-pointer'
  ].join(' ');

  const selectedLang = languages.find(l => l.value === selectedLanguage);

  return (
    <div className="space-y-2">
      <label htmlFor="language-select" className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
        Language
      </label>
      <select
        id="language-select"
        value={selectedLanguage}
        onChange={onChange}
        disabled={disabled || loading}
        aria-label="Select conversation language"
        aria-describedby="language-description"
        className={selectClasses}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.75rem center',
          paddingRight: '2.5rem'
        }}
      >
        {loading ? (
          <option>Loading languages...</option>
        ) : (
          languages.map((language) => (
            <option key={language.value} value={language.value}>
              {language.label}
            </option>
          ))
        )}
      </select>
      <p id="language-description" className="text-xs text-gray-500">
        {selectedLang?.description || ''}
      </p>
    </div>
  );
}
