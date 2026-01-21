-- Migration 017: Update voice and language configuration to use rich metadata
-- This migration transforms the simple array structure to object arrays with editable metadata

-- Update voices config to use object array with full metadata
UPDATE system_config
SET config_value = '{
  "voices": [
    {"value": "alloy", "label": "Alloy", "description": "Neutral & balanced", "enabled": true},
    {"value": "ash", "label": "Ash", "description": "Clear & articulate", "enabled": true},
    {"value": "ballad", "label": "Ballad", "description": "Smooth & melodic", "enabled": true},
    {"value": "cedar", "label": "Cedar", "description": "Warm & natural", "enabled": true},
    {"value": "coral", "label": "Coral", "description": "Gentle & friendly", "enabled": true},
    {"value": "echo", "label": "Echo", "description": "Warm & approachable", "enabled": true},
    {"value": "marin", "label": "Marin", "description": "Clear & professional", "enabled": true},
    {"value": "sage", "label": "Sage", "description": "Calm & soothing", "enabled": true},
    {"value": "shimmer", "label": "Shimmer", "description": "Bright & energetic", "enabled": true},
    {"value": "verse", "label": "Verse", "description": "Dynamic & expressive", "enabled": true}
  ],
  "default_voice": "cedar"
}'::jsonb
WHERE config_key = 'voices';

-- Update languages config to use object array with metadata and system prompt additions
UPDATE system_config
SET config_value = '{
  "languages": [
    {"value": "en", "label": "English", "description": "English", "enabled": true, "systemPromptAddition": ""},
    {"value": "es-ES", "label": "Español (España)", "description": "Spain Spanish", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Spanish from Spain (Español de España). Use European Spanish vocabulary, pronunciation, and expressions (vosotros, conducir, ordenador, etc.).**"},
    {"value": "es-419", "label": "Español (Latinoamérica)", "description": "Latin American Spanish", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Latin American Spanish (Español Latinoamericano). Use Latin American Spanish vocabulary and expressions (ustedes, manejar, computadora, etc.).**"},
    {"value": "fr-FR", "label": "Français (France)", "description": "France French", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in French from France (Français de France). Use standard French vocabulary and expressions.**"},
    {"value": "fr-CA", "label": "Français (Québec)", "description": "Québécois French", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Québécois French (Français Québécois). Use Canadian French vocabulary, pronunciation, and expressions.**"},
    {"value": "pt-BR", "label": "Português (Brasil)", "description": "Brazilian Portuguese", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Brazilian Portuguese (Português Brasileiro). Use Brazilian Portuguese vocabulary, pronunciation, and expressions.**"},
    {"value": "pt-PT", "label": "Português (Portugal)", "description": "European Portuguese", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in European Portuguese (Português Europeu). Use European Portuguese vocabulary, pronunciation, and expressions.**"},
    {"value": "de", "label": "Deutsch", "description": "German", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in German (Deutsch).**"},
    {"value": "it", "label": "Italiano", "description": "Italian", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Italian (Italiano).**"},
    {"value": "zh", "label": "中文", "description": "Chinese", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Chinese (中文).**"},
    {"value": "ja", "label": "日本語", "description": "Japanese", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Japanese (日本語).**"},
    {"value": "ko", "label": "한국어", "description": "Korean", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Korean (한국어).**"},
    {"value": "ar", "label": "العربية", "description": "Arabic", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Arabic (العربية).**"},
    {"value": "hi", "label": "हिन्दी", "description": "Hindi", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Hindi (हिन्दी).**"},
    {"value": "ru", "label": "Русский", "description": "Russian", "enabled": true, "systemPromptAddition": "\\n\\n**IMPORTANT: Please respond in Russian (Русский).**"}
  ],
  "default_language": "en"
}'::jsonb
WHERE config_key = 'languages';
