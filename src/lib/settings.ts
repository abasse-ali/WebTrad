import { useSyncExternalStore } from 'react';
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
    id: 'groq',
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (modèles « :free »)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
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
  v: 2,
  uiLang: browserUiLang(),
  sourceLang: 'auto',
  targetLang: defaultTarget(),
  provider: 'auto',
  ocrEngine: 'tesseract',
  myMemoryEmail: '',
  llm: defaultLlm,
  minConfidence: 40,
  font: 'comic',
  uppercase: false,
  corsProxy: '',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // v2: the source language is detected automatically by default.
    if ((parsed.v ?? 1) < 2) parsed.sourceLang = 'auto';
    return { ...DEFAULT_SETTINGS, ...parsed, v: 2, llm: { ...defaultLlm, ...(parsed.llm ?? {}) } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current: Settings = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
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
