import { X } from 'react-feather';

export default function SessionSettings({ isOpen, onClose, settings, onSettingsChange, disabled }) {
  if (!isOpen) return null;

  const voices = [
    { value: 'alloy', label: 'Alloy', description: 'Neutral & balanced' },
    { value: 'ash', label: 'Ash', description: 'Clear & articulate' },
    { value: 'ballad', label: 'Ballad', description: 'Smooth & melodic' },
    { value: 'cedar', label: 'Cedar', description: 'Warm & natural' },
    { value: 'coral', label: 'Coral', description: 'Gentle & friendly' },
    { value: 'echo', label: 'Echo', description: 'Warm & approachable' },
    { value: 'marin', label: 'Marin', description: 'Clear & professional' },
    { value: 'sage', label: 'Sage', description: 'Calm & soothing' },
    { value: 'shimmer', label: 'Shimmer', description: 'Bright & energetic' },
    { value: 'verse', label: 'Verse', description: 'Dynamic & expressive' }
  ];

  const languages = [
    { value: 'en', label: 'English', description: 'English' },
    { value: 'es-ES', label: 'Español (España)', description: 'Spain Spanish' },
    { value: 'es-419', label: 'Español (Latinoamérica)', description: 'Latin American Spanish' },
    { value: 'fr-FR', label: 'Français (France)', description: 'France French' },
    { value: 'fr-CA', label: 'Français (Québec)', description: 'Québécois French' },
    { value: 'pt-BR', label: 'Português (Brasil)', description: 'Brazilian Portuguese' },
    { value: 'pt-PT', label: 'Português (Portugal)', description: 'European Portuguese' },
    { value: 'de', label: 'Deutsch', description: 'German' },
    { value: 'it', label: 'Italiano', description: 'Italian' },
    { value: 'zh', label: '中文', description: 'Chinese' },
    { value: 'ja', label: '日本語', description: 'Japanese' },
    { value: 'ko', label: '한국어', description: 'Korean' },
    { value: 'ar', label: 'العربية', description: 'Arabic' },
    { value: 'hi', label: 'हिन्दी', description: 'Hindi' },
    { value: 'ru', label: 'Русский', description: 'Russian' }
  ];

  const handleVoiceChange = (e) => {
    onSettingsChange({ ...settings, voice: e.target.value });
  };

  const handleLanguageChange = (e) => {
    onSettingsChange({ ...settings, language: e.target.value });
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-fadeIn">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800">Session Settings</h2>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-100 rounded-full transition-colors"
            >
              <X size={20} className="text-gray-500" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-6 space-y-6">
            {/* Voice Selection */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
                Voice
              </label>
              <select
                value={settings.voice}
                onChange={handleVoiceChange}
                disabled={disabled}
                className="w-full px-3 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400 focus:ring-0 transition-colors disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed appearance-none cursor-pointer"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.75rem center',
                  paddingRight: '2.5rem'
                }}
              >
                {voices.map((voice) => (
                  <option key={voice.value} value={voice.value}>
                    {voice.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                {voices.find(v => v.value === settings.voice)?.description}
              </p>
            </div>

            {/* Language Selection */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-600 uppercase tracking-wide">
                Language
              </label>
              <select
                value={settings.language}
                onChange={handleLanguageChange}
                disabled={disabled}
                className="w-full px-3 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-gray-400 focus:ring-0 transition-colors disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed appearance-none cursor-pointer"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 0.75rem center',
                  paddingRight: '2.5rem'
                }}
              >
                {languages.map((language) => (
                  <option key={language.value} value={language.value}>
                    {language.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                {languages.find(l => l.value === settings.language)?.description}
              </p>
            </div>

            {/* Info Message */}
            {disabled && (
              <div className="pt-4 border-t border-gray-100">
                <p className="text-xs text-gray-500">
                  End current session to change settings
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-900 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
