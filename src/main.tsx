import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/comic-neue/700.css';
import './styles.css';
import { App } from './App';
import { resumeInterrupted } from './lib/pipeline';
import { installLogging } from './lib/log';
import { isNativeApp } from './lib/native';
import { getSettings } from './lib/settings';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

{
  const s = getSettings();
  installLogging({
    version: __APP_BUILD__,
    plateforme: isNativeApp() ? 'appli iPhone' : 'web',
    appareil: navigator.userAgent.replace(/^Mozilla\/5\.0 \(([^)]*)\).*$/, '$1').slice(0, 80),
    lecture: s.ocrEngine === 'vision' ? 'IA' : 'OCR local',
    traduction: s.provider,
    modèle: s.ocrEngine === 'vision' || s.provider === 'llm' ? `${s.llm.preset} · ${s.llm.model}` : '',
  });
}
void resumeInterrupted();

// Offline support: cache the app shell and the OCR engine after first use.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
