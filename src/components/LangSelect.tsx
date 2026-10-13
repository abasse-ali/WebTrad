import { AUTO, SOURCE_LANGUAGES, TARGET_LANGUAGES, displayName } from '../lib/languages';
import { useSettings } from '../lib/settings';

interface Props {
  value: string;
  onChange: (code: string) => void;
  kind: 'source' | 'target';
  id?: string;
  label?: string;
}

export function LangSelect({ value, onChange, kind, id, label }: Props) {
  const { uiLang } = useSettings();
  const list = kind === 'source' ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
  const sorted =
    kind === 'source'
      ? list
      : [...list].sort((a, b) => displayName(a.code, uiLang).localeCompare(displayName(b.code, uiLang), uiLang));
  return (
    <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {kind === 'source' && <option value={AUTO}>{displayName(AUTO, uiLang)}</option>}
      {sorted.map((l) => (
        <option key={l.code} value={l.code}>
          {kind === 'source'
            ? `${displayName(l.code, uiLang)} · ${'kind' in l ? l.kind : ''}`
            : `${displayName(l.code, uiLang)}${displayName(l.code, uiLang) !== l.name ? ` (${l.name})` : ''}`}
        </option>
      ))}
    </select>
  );
}
