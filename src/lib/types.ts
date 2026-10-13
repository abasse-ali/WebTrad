export type ChapterStatus = 'new' | 'processing' | 'done' | 'error' | 'partial';
export type PageStatus = 'pending' | 'ocr' | 'translating' | 'done' | 'error';

export interface Chapter {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Source language code, or 'auto' until it has been detected. */
  sourceLang: string;
  /** The source language was detected automatically. */
  autoSource?: boolean;
  targetLang: string;
  pageIds: string[];
  /** Small JPEG data URL used by the library grid. */
  cover?: string;
  /** Where the chapter came from (file names, URL…) – informative only. */
  origin?: string;
  /** Index of the last page the reader looked at. */
  lastPage?: number;
  /** Page counters, refreshed while the chapter is processed. */
  stats?: { done: number; errors: number; total: number };
}

export interface Bubble {
  id: string;
  /** Text box in original image pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Room available for the translation (inside the speech bubble). */
  area?: { x: number; y: number; w: number; h: number };
  original: string;
  translation: string;
  /** Mean OCR confidence 0–100 (absent for manual / AI boxes). */
  confidence?: number;
  /** Height of the original lettering in px, used to size the translation. */
  fontSize?: number;
  /** Text orientation of the source, used for re-OCR. */
  vertical?: boolean;
  /** Erase colour (auto-detected when undefined). */
  fill?: string;
  /** Background behind the text is not flat: draw an outline around letters. */
  outline?: boolean;
  /** Text colour (auto: black or white depending on fill). */
  color?: string;
  /** Multiplier applied to the auto-fitted font size. */
  fontScale?: number;
  /** When true the original text is left untouched on the page. */
  hidden?: boolean;
  /** Set when the user typed the translation by hand. */
  edited?: boolean;
}

export interface Page {
  id: string;
  chapterId: string;
  index: number;
  name: string;
  width: number;
  height: number;
  blob: Blob;
  status: PageStatus;
  error?: string;
  /** Incremented on every change (cheap equality check for the UI). */
  rev?: number;
  bubbles: Bubble[];
}

export type ProviderId = 'auto' | 'chrome' | 'google' | 'mymemory' | 'llm';
export type OcrEngine = 'tesseract' | 'vision';
export type FontId = 'comic' | 'sans' | 'serif';
export type ReaderMode = 'translated' | 'original' | 'compare';

export interface LlmSettings {
  preset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Settings {
  /** Settings schema version (used for one-off migrations). */
  v?: number;
  uiLang: 'fr' | 'en';
  sourceLang: string;
  targetLang: string;
  provider: ProviderId;
  ocrEngine: OcrEngine;
  myMemoryEmail: string;
  llm: LlmSettings;
  minConfidence: number;
  font: FontId;
  uppercase: boolean;
  corsProxy: string;
  /** Maximum size of an exported .cbz in megabytes (0 = no limit). */
  exportMaxMB: number;
}
