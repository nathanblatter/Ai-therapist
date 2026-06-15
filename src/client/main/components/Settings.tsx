import React, { useEffect, useRef, useState } from "react";

/*
  Settings dropdown — compact floating gear button
  - Small gear icon fixed to bottom-right
  - Click opens a floating menu above the button
  - Keeps voice/language/theme logic and localStorage persistence
*/

const LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "it-IT", label: "Italiano" },
];

function useLocalStorage(key, initial) {
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  }, [key, state]);
  return [state, setState];
}

export function SettingsDropdown({ onOpenSettings, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = useLocalStorage("settings.voiceURI", "");
  const [language, setLanguage] = useLocalStorage("settings.lang", "en-US");
  const [theme, setTheme] = useLocalStorage("settings.theme", "system"); // system | light | dark
  const [features, setFeatures] = useState({
    output_modalities: ["audio"],
    voice_enabled: true,
    chat_enabled: true
  });

  const rootRef = useRef(null);
  const btnRef = useRef(null);

  // Fetch features config to determine if voice is enabled
  useEffect(() => {
    fetch('/api/config/features')
      .then(res => res.json())
      .then(data => setFeatures(data))
      .catch(err => console.error('Failed to fetch features config:', err));
  }, []);

  // Load voices from SpeechSynthesis API
  useEffect(() => {
    function load() {
      try {
        const v = ['Alloy','Ash','Ballad','Cedar','Coral','Echo','Marin','Sage','Shimmer','Verse'];
        setVoices(v);
        if (!selectedVoiceURI && v.length) {
          const preferred = v.find((x) => x.lang && x.lang.startsWith(language)) || v[0];
          if (preferred) setSelectedVoiceURI(preferred.voiceURI);
        }
      } catch {
        setVoices([]);
      }
    }
    load();
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    return () => {
      window.speechSynthesis?.removeEventListener?.("voiceschanged", load);
    };
  }, [language, setSelectedVoiceURI, selectedVoiceURI]);

  // Close on outside click or Escape
  useEffect(() => {
    function onDoc(e) {
      if (!open) return;
      if (
        rootRef.current &&
        !rootRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Apply theme to <html>
  useEffect(() => {
    const html = document.documentElement;
    html.classList.remove("light", "dark");
    if (theme === "light") html.classList.add("light");
    else if (theme === "dark") html.classList.add("dark");
  }, [theme]);

  // Preview voice function
  function speakPreview() {
    if (!selectedVoiceURI) return;
    const utterance = new SpeechSynthesisUtterance("Hello! This is a preview of the selected voice.");
    const voice = window.speechSynthesis.getVoices().find(v => v.voiceURI === selectedVoiceURI);
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }



  // If language changed and a matching voice exists, auto-select it
  useEffect(() => {
    if (!selectedVoiceURI && voices.length) return;
    const matching = voices.find((v) => v.lang && v.lang.startsWith(language));
    if (matching && matching.voiceURI !== selectedVoiceURI) {
      setSelectedVoiceURI(matching.voiceURI);
    }
  }, [language, voices, selectedVoiceURI, setSelectedVoiceURI]);

  return (
    // fixed container so the gear is always visible; menu is absolute relative to this
    <div ref={rootRef} className="fixed bottom-6 right-6 z-50">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Open settings menu"
        onClick={() => setOpen((v) => !v)}
        className="h-12 w-12 inline-flex items-center justify-center rounded-full bg-byuRoyal text-white shadow-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-300 min-h-[44px] min-w-[44px]"
      >
        <span className="text-lg" aria-hidden="true">⚙️</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Settings"
          className="absolute right-0 bottom-16 w-80 rounded-2xl bg-white p-4 shadow-2xl ring-1 ring-black ring-opacity-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">App settings</h3>
              <p className="mt-1 text-xs text-gray-500">
                Configure {features.output_modalities && features.output_modalities.includes("audio") ? "voice, language, and page theme" : "language and page theme"}.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1 text-gray-400 hover:text-gray-600 focus:outline-none"
              aria-label="Close settings"
            >
              ✕
            </button>
          </div>

          <div className="mt-4 space-y-4">
            {/* Voice - only show if output_modalities includes "audio" (realtime mode) */}
            {features.output_modalities && features.output_modalities.includes("audio") && (
              <div>
                <label htmlFor="settings-voice-select" className="block text-xs font-medium text-gray-600">Voice</label>
                <div className="mt-2 flex gap-2">
                  <select
                    id="settings-voice-select"
                    value={selectedVoiceURI}
                    onChange={(e) => setSelectedVoiceURI(e.target.value)}
                    aria-label="Select browser voice for speech synthesis"
                    className="flex-1 rounded-lg border px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  >
                    {voices.length === 0 && <option value="">(No voices available)</option>}
                    {voices.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} — {v.lang}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={speakPreview}
                    aria-label="Preview selected voice"
                    className="rounded-lg bg-byuRoyal px-3 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 min-h-[44px]"
                  >
                    Preview
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-400">Browser speech synthesis voices (if supported).</p>
              </div>
            )}

            {/* Language */}
            <div>
              <label className="block text-xs font-medium text-gray-600">Language</label>
              <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Language selection">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => setLanguage(lang.code)}
                    aria-label={`Select ${lang.label}`}
                    aria-pressed={language === lang.code}
                    className={`justify-start rounded-lg border px-3 py-2 text-sm text-left min-h-[44px] ${
                      language === lang.code
                        ? "bg-indigo-50 border-indigo-300 text-indigo-700 shadow-sm"
                        : "bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span>{lang.label}</span>
                      {language === lang.code && <span className="text-xs text-indigo-600">Selected</span>}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Theme */}
            <div>
              <label className="block text-xs font-medium text-gray-600">Page theme</label>
              <div className="mt-2 flex items-center gap-2" role="group" aria-label="Theme selection">
                <label className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer select-none min-h-[44px]">
                  <input
                    type="radio"
                    name="theme"
                    value="system"
                    checked={theme === "system"}
                    onChange={() => setTheme("system")}
                    aria-label="Use system theme preference"
                    className="h-4 w-4"
                  />
                  <span className="text-sm">System</span>
                </label>

                <label className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer select-none min-h-[44px]">
                  <input
                    type="radio"
                    name="theme"
                    value="light"
                    checked={theme === "light"}
                    onChange={() => setTheme("light")}
                    aria-label="Use light theme"
                    className="h-4 w-4"
                  />
                  <span className="text-sm">Light</span>
                </label>

                <label className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer select-none min-h-[44px]">
                  <input
                    type="radio"
                    name="theme"
                    value="dark"
                    checked={theme === "dark"}
                    onChange={() => setTheme("dark")}
                    aria-label="Use dark theme"
                    className="h-4 w-4"
                  />
                  <span className="text-sm">Dark</span>
                </label>
              </div>
              <p className="mt-1 text-xs text-gray-400">Theme change is applied to the document element.</p>
            </div>

            {/* Action row */}
            <div className="mt-1 flex items-center justify-between gap-3">

              <div className="flex items-center gap-2">

                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSignOut?.();
                  }}
                  aria-label="Sign out of your account"
                  className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 hover:bg-red-100 focus:outline-none min-h-[44px]"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsDropdownDemo() {
  return <SettingsDropdown />;
}
