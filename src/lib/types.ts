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
  /** Artwork of the manga (from the site, or chosen by the reader), shown instead of `cover`. */
  seriesCover?: string;
  /** `seriesCover` was chosen by the reader: never replaced automatically. */
  coverChosen?: boolean;
  /** Address the chapter was imported from, when it came from a link. */
  origin?: string;
  /** Address of the following chapter, when the source page links to it. */
  nextUrl?: string;
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
  /** Tilt of the original lettering in degrees, clockwise. */
  rotation?: number;
  /** Slant of italic or handwritten lettering: how far letters lean right per unit of height. */
  slant?: number;
  /** Lettering on the artwork with plain paper around: its translation may take more room. */
  roomy?: boolean;
  /** Colour of the outline around the letters, when the original has one of its own. */
  outlineColor?: string;
  /**
   * The inside of the bubble, row by row (page pixels, margin taken off):
   * rows from `y`, every `step` pixels, each `[left, right]` in `x`. The
   * translation is wrapped line by line to the width the bubble has at the
   * height of each line, so it never runs over the rim of a round or spiky
   * bubble.
   */
  shape?: {
    y: number;
    step: number;
    x: number[];
    /** Margin taken off the rim (page pixels): the rim itself is this much further out. */
    inset?: number;
    /** Colour of the bubble's outline, for drawing it a little bigger when the translation needs room. */
    rim?: string;
    /** The whole bubble (not one lobe of two bubbles drawn joined): it may be drawn bigger. */
    whole?: boolean;
  };
  /** Alignment of the original lines (centred when undefined). */
  align?: 'left' | 'right';
  /** Artwork repaired under the lettering (data URL) and the rectangle it covers. */
  patch?: string;
  patchBox?: { x: number; y: number; w: number; h: number };
  /** Multiplier applied to the auto-fitted font size. */
  fontScale?: number;
  /** When true the original text is left untouched on the page. */
  hidden?: boolean;
  /** Set when the user typed the translation by hand. */
  edited?: boolean;
  /**
   * Bubble cut by the page break: the same text is lettered on both pages
   * ("next": its top part here, the rest on the next page; "prev": the end
   * of a bubble that starts on the previous page). Its area runs past the
   * page edge and is clipped there.
   */
  seam?: 'next' | 'prev';
  /** Who says it (from the AI), for reading aloud with that character's voice. */
  speaker?: string;
  gender?: 'male' | 'female';
  kind?: 'dialogue' | 'thought' | 'narration' | 'sign';
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
  /** Times the app died while this page was being processed (crash-loop guard). */
  stalled?: number;
  /** Incremented on every change (cheap equality check for the UI). */
  rev?: number;
  bubbles: Bubble[];
}

export type ProviderId = 'auto' | 'chrome' | 'google' | 'mymemory' | 'llm';
export type OcrEngine = 'tesseract' | 'vision';
export type FontId = 'comic' | 'sans' | 'serif';
export type ThemeId = 'auto' | 'light' | 'dark';
/** `original`: capitals when the source lettering is in capitals. */
export type LetterCase = 'original' | 'upper' | 'normal';
export type ReaderMode = 'translated' | 'original' | 'compare';

export interface LlmSettings {
  preset: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * What was set for each provider (key, model, address), remembered when
   * switching to another one: going back to NVIDIA or OpenRouter restores
   * its own key instead of asking for it again. Kept on the device only.
   */
  saved?: Record<string, { apiKey: string; model: string; baseUrl: string }>;
}

export interface Settings {
  /** Settings schema version (used for one-off migrations). */
  v?: number;
  uiLang: 'fr' | 'en';
  theme: ThemeId;
  sourceLang: string;
  targetLang: string;
  provider: ProviderId;
  ocrEngine: OcrEngine;
  myMemoryEmail: string;
  llm: LlmSettings;
  minConfidence: number;
  font: FontId;
  letterCase: LetterCase;
  corsProxy: string;
  /** Maximum size of an exported .cbz in megabytes (0 = no limit). */
  exportMaxMB: number;
  /** iPhone app: keep translating when the app leaves the screen or the phone is locked. */
  background: boolean;
  /** Automatic scrolling in the reader: speed level (1 = slowest). */
  scrollSpeed: number;
  /** Reading aloud: speed of the voices (1 = normal). */
  voiceRate: number;
}
