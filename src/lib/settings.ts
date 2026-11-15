import { useSyncExternalStore } from 'react';
import { DEFAULT_SPEED } from './autoscroll';
import type { LlmSettings, Settings } from './types';

const KEY = 'webtrad.settings.v1';

export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Link where a free API key can be created. */
  keyUrl?: string;
  /** Model is able to read images (needed for the AI vision OCR mode). */
  vision?: boolean;
  needsKey: boolean;
  note?: { fr: string; en: string };
  /**
   * Order of the box coordinates the model is best at: Gemini answers
   * [ymin, xmin, ymax, xmax], Qwen-style vision models [xmin, ymin, xmax, ymax].
   */
  boxOrder?: 'yxyx' | 'xyxy';
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'gemini',
    label: 'Google Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
    keyUrl: 'https://aistudio.google.com/apikey',
    vision: true,
    needsKey: true,
    note: {
      fr: 'Clé gratuite sur Google AI Studio. Lit les images : idéal pour le mode « OCR par IA ».',
      en: 'Free key from Google AI Studio. Reads images: best for the “AI OCR” mode.',
    },
  },
  {
    id: 'nvidia',
    label: 'NVIDIA (gratuit, build.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'qwen/qwen3.5-397b-a17b',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    vision: true,
    needsKey: true,
    boxOrder: 'xyxy',
    note: {
      fr: 'Clé gratuite (commence par « nvapi- ») sur build.nvidia.com, compte NVIDIA Developer gratuit. Le modèle par défaut lit les images ; « Lister les modèles » montre ceux de votre compte. Dans l’application iPhone, aucun réglage de plus ; sur le site web, NVIDIA peut refuser les appels venant d’un navigateur.',
      en: 'Free key (starts with “nvapi-”) on build.nvidia.com, free NVIDIA Developer account. The default model reads images; “List models” shows the ones of your account. Works as is in the iPhone app; on the website NVIDIA may refuse calls made from a browser.',
    },
  },
  {
    id: 'groq',
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (modèles gratuits)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemma-3-27b-it:free',
    keyUrl: 'https://openrouter.ai/keys',
    vision: true,
    needsKey: true,
    note: {
      fr: 'Clé gratuite sur openrouter.ai (sans carte bancaire). « Lister les modèles » ne montre que les modèles gratuits ; ceux qui lisent les images servent à l’OCR par IA. Les modèles gratuits sont limités (environ 50 requêtes par jour sans crédit acheté).',
      en: 'Free key on openrouter.ai (no card needed). “List models” shows the free models only; the image-reading ones serve the AI OCR mode. Free models are limited (about 50 requests a day without bought credit).',
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    note: {
      fr: 'Lancez Ollama avec OLLAMA_ORIGINS=* pour autoriser le navigateur.',
      en: 'Start Ollama with OLLAMA_ORIGINS=* so the browser may call it.',
    },
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    needsKey: false,
    note: {
      fr: 'Activez « CORS » dans le serveur local de LM Studio.',
      en: 'Enable “CORS” in LM Studio’s local server.',
    },
  },
  { id: 'custom', label: 'OpenAI-compatible', baseUrl: '', model: '', needsKey: false },
];

function browserUiLang(): 'fr' | 'en' {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'fr';
  return lang.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

function defaultTarget(): string {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'fr';
  const base = lang.split('-')[0].toLowerCase();
  if (base === 'zh') return /tw|hk|hant/i.test(lang) ? 'zh-Hant' : 'zh-Hans';
  return base || 'fr';
}

const defaultLlm: LlmSettings = {
  preset: 'gemini',
  baseUrl: LLM_PRESETS[0].baseUrl,
  apiKey: '',
  model: LLM_PRESETS[0].model,
};

export const DEFAULT_SETTINGS: Settings = {
  v: 4,
  uiLang: browserUiLang(),
  theme: 'auto',
  sourceLang: 'auto',
  targetLang: defaultTarget(),
  provider: 'auto',
  ocrEngine: 'tesseract',
  myMemoryEmail: '',
  llm: defaultLlm,
  minConfidence: 40,
  font: 'comic',
  letterCase: 'original',
  corsProxy: '',
  exportMaxMB: 30,
  background: true,
  animated: true,
  scrollSpeed: DEFAULT_SPEED,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // v2: the source language is detected automatically by default.
    if ((parsed.v ?? 1) < 2) parsed.sourceLang = 'auto';
    // v4: back to automatic detection: an older version saved the language
    // chosen (or detected) for one chapter as the default of every new one.
    if ((parsed.v ?? 1) < 4) parsed.sourceLang = 'auto';
    // v3: the UPPERCASE switch became "same case as the original" by default.
    const legacy = parsed as { uppercase?: boolean };
    if ((parsed.v ?? 1) < 3 && legacy.uppercase) parsed.letterCase = 'upper';
    delete legacy.uppercase;
    return { ...DEFAULT_SETTINGS, ...parsed, v: 4, llm: { ...defaultLlm, ...(parsed.llm ?? {}) } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** `auto` follows the device; otherwise the choice is forced on the root element. */
function applyTheme(settings: Settings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (settings.theme === 'light' || settings.theme === 'dark') root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
}

let current: Settings = load();
applyTheme(current);
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  applyTheme(current);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: settings live for this session only */
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
