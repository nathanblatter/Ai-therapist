import { useEffect, useRef, useState } from 'react';
import { X, Volume2, Square } from 'react-feather';
import {
  THEMES,
  getStoredTheme,
  setTheme,
  getStoredA11y,
  setA11y,
  type A11yPrefs,
} from '../../shared/theme';

interface VoiceOption {
  value: string;
  label: string;
  description: string;
}

interface LanguageOption {
  value: string;
  label: string;
  description: string;
}

interface SessionSettingsConfig {
  voice: string;
  language: string;
}

interface SessionSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: SessionSettingsConfig;
  onSettingsChange: (newSettings: SessionSettingsConfig) => void;
  disabled: boolean;
}

export default function SessionSettings({ isOpen, onClose, settings, onSettingsChange, disabled }: SessionSettingsProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [availableVoices, setAvailableVoices] = useState<VoiceOption[]>([]);
  const [availableLanguages, setAvailableLanguages] = useState<LanguageOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  // null = anonymous user (no account to remember sessions against) → hidden.
  const [memoryEnabled, setMemoryEnabled] = useState<boolean | null>(null);
  const [theme, setThemeState] = useState('default');
  const [a11y, setA11yState] = useState<A11yPrefs>(getStoredA11y());

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
          setAvailableVoices((data.voices as VoiceOption[]) || []);
        }

        if (languagesRes.ok) {
          const data = await languagesRes.json();
          setAvailableLanguages((data.languages as LanguageOption[]) || []);
        }
      } catch (err: unknown) {
        console.error('Failed to fetch voice/language options:', err);
        setAvailableVoices([{ value: 'cedar', label: 'Cedar', description: 'Warm & natural' }]);
        setAvailableLanguages([{ value: 'en', label: 'English', description: 'English' }]);
      } finally {
        setLoadingOptions(false);
      }
    };

    fetchOptions();

    // Session-memory consent — only exists for logged-in users (401 → hide).
    fetch('/api/users/preferences', { credentials: 'include' })
      .then(res => (res.ok ? res.json() : null))
      .then(prefs => setMemoryEnabled(prefs ? Boolean(prefs.memory_enabled) : null))
      .catch(() => setMemoryEnabled(null));

    // Theme/accessibility are already applied to <html>; sync the controls.
    setThemeState(getStoredTheme());
    setA11yState(getStoredA11y());
  }, [isOpen]);

  const handleThemeSelect = (value: string) => {
    setThemeState(value);
    setTheme(value); // applies to <html> + localStorage (works for anonymous users too)
    // Best-effort server persistence for logged-in users (401 for anonymous is fine).
    fetch('/api/users/preferences/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ theme: value }),
    }).catch(() => {});
  };

  const handleA11yChange = (patch: Partial<A11yPrefs>) => {
    const next = { ...a11y, ...patch };
    setA11yState(next);
    setA11y(next);
  };

  const handleMemoryToggle = async (enabled: boolean) => {
    setMemoryEnabled(enabled); // optimistic
    try {
      const res = await fetch('/api/users/preferences/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) setMemoryEnabled(!enabled);
    } catch (err) {
      console.error('Failed to save memory preference:', err);
      setMemoryEnabled(!enabled);
    }
  };

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
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
  const savePreferences = async (newSettings: SessionSettingsConfig) => {
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
    } catch (err: unknown) {
      console.error('Failed to save preferences:', err);
    }
  };

  // Handle voice selection
  const handleVoiceSelect = (voiceValue: string) => {
    if (disabled) return;
    const newSettings = { ...settings, voice: voiceValue };
    onSettingsChange(newSettings);
    savePreferences(newSettings);
  };

  // Handle language selection
  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSettings = { ...settings, language: e.target.value };
    onSettingsChange(newSettings);
    savePreferences(newSettings);
  };

  // Handle voice preview playback
  const handlePlayPreview = (voiceValue: string) => {
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
      .catch((err: unknown) => {
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
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto animate-fadeIn">
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              {/* Voice Selection - takes 2 columns */}
              <div className="sm:col-span-2">
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
              <div className="sm:col-span-1">
                <LanguageSelector
                  languages={availableLanguages}
                  selectedLanguage={settings.language}
                  onChange={handleLanguageChange}
                  loading={loadingOptions}
                  disabled={disabled}
                />
              </div>
            </div>

            {/* Appearance: theme presets (applies immediately, saved per-user) */}
            <div className="mt-6 pt-6 border-t border-gray-100">
              <ThemeSelector selectedTheme={theme} onSelect={handleThemeSelect} />
            </div>

            {/* Accessibility */}
            <div className="mt-6 pt-6 border-t border-gray-100">
              <AccessibilityControls prefs={a11y} onChange={handleA11yChange} />
            </div>

            {/* Session memory consent (logged-in users only) */}
            {memoryEnabled !== null && (
              <div className="mt-6 pt-6 border-t border-gray-100">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-700">Session memory</h3>
                    <p className="text-xs text-gray-500 mt-1 max-w-md">
                      When on, the AI keeps a short thematic summary of each conversation
                      (never a transcript) and uses it for continuity next time — e.g.
                      &ldquo;last time we talked about…&rdquo;. You can turn this off anytime.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={memoryEnabled}
                    aria-label="Toggle session memory"
                    onClick={() => handleMemoryToggle(!memoryEnabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                      memoryEnabled ? 'bg-blue-600' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        memoryEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
            )}

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

interface VoiceSelectorProps {
  voices: VoiceOption[];
  selectedVoice: string;
  playingVoice: string | null;
  onSelect: (voiceValue: string) => void;
  onPlayPreview: (voiceValue: string) => void;
  loading: boolean;
  disabled: boolean;
}

// Voice Selector Component
function VoiceSelector({ voices, selectedVoice, playingVoice, onSelect, onPlayPreview, loading, disabled }: VoiceSelectorProps) {
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {voices.map((voice) => (
          <VoiceOptionCard
            key={voice.value}
            voice={voice}
            isSelected={selectedVoice === voice.value}
            isPlaying={playingVoice === voice.value}
            onSelect={() => onSelect(voice.value)}
            onPlayPreview={(e: React.MouseEvent) => {
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

interface VoiceOptionCardProps {
  voice: VoiceOption;
  isSelected: boolean;
  isPlaying: boolean;
  onSelect: () => void;
  onPlayPreview: (e: React.MouseEvent) => void;
  disabled: boolean;
}

// Voice Option Component
function VoiceOptionCard({ voice, isSelected, isPlaying, onSelect, onPlayPreview, disabled }: VoiceOptionCardProps) {
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

interface ThemeSelectorProps {
  selectedTheme: string;
  onSelect: (value: string) => void;
}

// Theme preset picker — swatch cards, applied live as you click
function ThemeSelector({ selectedTheme, onSelect }: ThemeSelectorProps) {
  return (
    <div className="space-y-3">
      <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
        Appearance
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2" role="radiogroup" aria-label="Color theme">
        {THEMES.map((t) => (
          <button
            key={t.value}
            role="radio"
            aria-checked={selectedTheme === t.value}
            onClick={() => onSelect(t.value)}
            className={`flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all cursor-pointer ${
              selectedTheme === t.value ? 'border-gray-800 bg-gray-50' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <span className="flex -space-x-1" aria-hidden="true">
              {t.swatch.map((color, i) => (
                <span
                  key={i}
                  className="inline-block w-5 h-5 rounded-full border border-white shadow-sm"
                  style={{ backgroundColor: color }}
                />
              ))}
            </span>
            <span className="text-xs font-medium text-gray-700">{t.label}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-500">Theme applies right away and is remembered for next time.</p>
    </div>
  );
}

interface AccessibilityControlsProps {
  prefs: A11yPrefs;
  onChange: (patch: Partial<A11yPrefs>) => void;
}

const FONT_SIZES: Array<{ value: A11yPrefs['fontSize']; label: string }> = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Default' },
  { value: 'lg', label: 'Large' },
  { value: 'xl', label: 'Extra large' },
];

function A11yToggle({ label, description, checked, onToggle }: {
  label: string;
  description: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h4 className="text-sm font-medium text-gray-700">{label}</h4>
        <p className="text-xs text-gray-500 mt-0.5 max-w-md">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={`Toggle ${label.toLowerCase()}`}
        onClick={() => onToggle(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

// Accessibility preferences — stored on this device, applied instantly
function AccessibilityControls({ prefs, onChange }: AccessibilityControlsProps) {
  return (
    <div className="space-y-4">
      <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
        Accessibility
      </label>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-medium text-gray-700">Text size</h4>
          <p className="text-xs text-gray-500 mt-0.5">Scales all text in the app.</p>
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden" role="radiogroup" aria-label="Text size">
          {FONT_SIZES.map((size) => (
            <button
              key={size.value}
              role="radio"
              aria-checked={prefs.fontSize === size.value}
              onClick={() => onChange({ fontSize: size.value })}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                prefs.fontSize === size.value
                  ? 'bg-gray-800 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-100'
              }`}
            >
              {size.label}
            </button>
          ))}
        </div>
      </div>

      <A11yToggle
        label="Reduce motion"
        description="Turns off animations and transitions. Follows your device setting unless changed here."
        checked={prefs.motion === 'reduce'}
        onToggle={(checked) => onChange({ motion: checked ? 'reduce' : 'system' })}
      />
      <A11yToggle
        label="High contrast"
        description="Darkens muted text and strengthens borders for easier reading."
        checked={prefs.contrast === 'high'}
        onToggle={(checked) => onChange({ contrast: checked ? 'high' : 'normal' })}
      />
      <A11yToggle
        label="Dyslexia-friendly text"
        description="Uses a more readable font with wider letter spacing."
        checked={prefs.font === 'dyslexic'}
        onToggle={(checked) => onChange({ font: checked ? 'dyslexic' : 'default' })}
      />
    </div>
  );
}

interface LanguageSelectorProps {
  languages: LanguageOption[];
  selectedLanguage: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  loading: boolean;
  disabled: boolean;
}

// Language Selector Component
function LanguageSelector({ languages, selectedLanguage, onChange, loading, disabled }: LanguageSelectorProps) {
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
