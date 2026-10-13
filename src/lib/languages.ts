export interface SourceLanguage {
  code: string;
  /** Native name. */
  name: string;
  /** Tesseract traineddata names, horizontal first. */
  tesseract: string[];
  /** Characters that must dominate an OCR line for it to be kept. */
  script: RegExp;
  /** Scripts written without spaces between words. */
  noSpaces?: boolean;
  /** Source that is often written vertically (manga). */
  vertical?: boolean;
  kind: string;
}

const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/u;
const KANA_KANJI = /[぀-ヿㇰ-ㇿ一-鿿㐀-䶿ｦ-ﾟ]/u;
const HAN = /[一-鿿㐀-䶿豈-﫿]/u;
const LATIN = /[A-Za-zÀ-ɏḀ-ỿ]/u;
const CYRILLIC = /[Ѐ-ӿ]/u;
const THAI = /[฀-๿]/u;

export const SOURCE_LANGUAGES: SourceLanguage[] = [
  { code: 'ko', name: '한국어', kind: 'Manhwa / Webtoon', tesseract: ['kor'], script: HANGUL },
  { code: 'ja', name: '日本語', kind: 'Manga', tesseract: ['jpn', 'jpn_vert'], script: KANA_KANJI, noSpaces: true, vertical: true },
  { code: 'zh-Hans', name: '简体中文', kind: 'Manhua', tesseract: ['chi_sim', 'chi_sim_vert'], script: HAN, noSpaces: true },
  { code: 'zh-Hant', name: '繁體中文', kind: 'Manhua', tesseract: ['chi_tra', 'chi_tra_vert'], script: HAN, noSpaces: true, vertical: true },
  { code: 'en', name: 'English', kind: 'Comics', tesseract: ['eng'], script: LATIN },
  { code: 'fr', name: 'Français', kind: 'BD', tesseract: ['fra'], script: LATIN },
  { code: 'es', name: 'Español', kind: 'Cómics', tesseract: ['spa'], script: LATIN },
  { code: 'pt', name: 'Português', kind: 'Quadrinhos', tesseract: ['por'], script: LATIN },
  { code: 'it', name: 'Italiano', kind: 'Fumetti', tesseract: ['ita'], script: LATIN },
  { code: 'de', name: 'Deutsch', kind: 'Comics', tesseract: ['deu'], script: LATIN },
  { code: 'ru', name: 'Русский', kind: 'Комиксы', tesseract: ['rus'], script: CYRILLIC },
  { code: 'id', name: 'Bahasa Indonesia', kind: 'Komik', tesseract: ['ind'], script: LATIN },
  { code: 'vi', name: 'Tiếng Việt', kind: 'Truyện tranh', tesseract: ['vie'], script: LATIN },
  { code: 'th', name: 'ไทย', kind: 'การ์ตูน', tesseract: ['tha'], script: THAI, noSpaces: true },
];

export interface TargetLanguage {
  code: string;
  name: string;
  /** Code understood by Google Translate / MyMemory when it differs. */
  google?: string;
  /** BCP 47 tag for the browser's built-in Translator API when it differs. */
  chrome?: string;
  rtl?: boolean;
  /** Script without spaces between words: wrap on characters / segments. */
  noSpaces?: boolean;
}

export const TARGET_LANGUAGES: TargetLanguage[] = [
  { code: 'fr', name: 'Français' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'de', name: 'Deutsch' },
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'fa', name: 'فارسی', rtl: true },
  { code: 'he', name: 'עברית', google: 'iw', rtl: true },
  { code: 'ur', name: 'اردو', rtl: true },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'bn', name: 'বাংলা' },
  { code: 'ta', name: 'தமிழ்' },
  { code: 'te', name: 'తెలుగు' },
  { code: 'mr', name: 'मराठी' },
  { code: 'gu', name: 'ગુજરાતી' },
  { code: 'kn', name: 'ಕನ್ನಡ' },
  { code: 'ml', name: 'മലയാളം' },
  { code: 'pa', name: 'ਪੰਜਾਬੀ' },
  { code: 'ne', name: 'नेपाली' },
  { code: 'th', name: 'ไทย', noSpaces: true },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'fil', name: 'Filipino', google: 'tl' },
  { code: 'ja', name: '日本語', noSpaces: true },
  { code: 'ko', name: '한국어' },
  { code: 'zh-Hans', name: '简体中文', google: 'zh-CN', chrome: 'zh', noSpaces: true },
  { code: 'zh-Hant', name: '繁體中文', google: 'zh-TW', noSpaces: true },
  { code: 'sv', name: 'Svenska' },
  { code: 'no', name: 'Norsk', chrome: 'nb' },
  { code: 'da', name: 'Dansk' },
  { code: 'fi', name: 'Suomi' },
  { code: 'cs', name: 'Čeština' },
  { code: 'sk', name: 'Slovenčina' },
  { code: 'hu', name: 'Magyar' },
  { code: 'ro', name: 'Română' },
  { code: 'bg', name: 'Български' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'sr', name: 'Српски' },
  { code: 'hr', name: 'Hrvatski' },
  { code: 'sl', name: 'Slovenščina' },
  { code: 'lt', name: 'Lietuvių' },
  { code: 'lv', name: 'Latviešu' },
  { code: 'et', name: 'Eesti' },
  { code: 'ka', name: 'ქართული' },
  { code: 'hy', name: 'Հայերեն' },
  { code: 'az', name: 'Azərbaycan' },
  { code: 'kk', name: 'Қазақ' },
  { code: 'uz', name: 'Oʻzbek' },
  { code: 'mn', name: 'Монгол' },
  { code: 'km', name: 'ខ្មែរ', noSpaces: true },
  { code: 'lo', name: 'ລາວ', noSpaces: true },
  { code: 'my', name: 'မြန်မာ', noSpaces: true },
  { code: 'sw', name: 'Kiswahili' },
  { code: 'am', name: 'አማርኛ' },
  { code: 'ca', name: 'Català' },
];

/** Source language value meaning "detect it from the pages". */
export const AUTO = 'auto';

/** Maps a language tag returned by an AI model to one of our source codes. */
export function normaliseSourceCode(tag: string | undefined): string | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase();
  if (/^zh[-_](tw|hk|mo|hant)/.test(t)) return 'zh-Hant';
  if (t.startsWith('zh')) return 'zh-Hans';
  const base = t.split(/[-_]/)[0];
  return SOURCE_LANGUAGES.some((l) => l.code === base) ? base : null;
}

export function sourceLanguage(code: string): SourceLanguage {
  return SOURCE_LANGUAGES.find((l) => l.code === code) ?? SOURCE_LANGUAGES[0];
}

export function targetLanguage(code: string): TargetLanguage {
  return TARGET_LANGUAGES.find((l) => l.code === code) ?? TARGET_LANGUAGES[0];
}

export function googleCode(code: string): string {
  if (code === AUTO) return 'auto';
  const target = TARGET_LANGUAGES.find((l) => l.code === code);
  if (target?.google) return target.google;
  if (code === 'zh-Hans') return 'zh-CN';
  if (code === 'zh-Hant') return 'zh-TW';
  return code;
}

export function chromeCode(code: string): string {
  const target = TARGET_LANGUAGES.find((l) => l.code === code);
  if (target?.chrome) return target.chrome;
  if (code === 'zh-Hans') return 'zh';
  return code;
}

/** English name of a language, used in LLM prompts. */
export function englishName(code: string): string {
  if (code === AUTO) return 'the original language (detect it)';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Name of a language in the UI language. */
export function displayName(code: string, uiLang: string): string {
  if (code === AUTO) return uiLang === 'fr' ? 'Détection automatique' : 'Auto-detect';
  try {
    const name = new Intl.DisplayNames([uiLang], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(uiLang) + name.slice(1);
  } catch {
    /* fall through */
  }
  return targetLanguage(code).name;
}
