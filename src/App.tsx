import { useEffect } from 'react';
import { useT } from './i18n';
import { useSettings } from './lib/settings';
import { navigate, useRoute } from './router';
import { Icon } from './components/Icon';
import { Library } from './components/Library';
import { NewChapter } from './components/NewChapter';
import { Reader } from './components/Reader';
import { SettingsPage } from './components/SettingsPage';

export function App() {
  const route = useRoute();
  const t = useT();
  const { uiLang } = useSettings();

  useEffect(() => {
    document.documentElement.lang = uiLang;
  }, [uiLang]);

  // Every screen starts at its top, another chapter included (the reader
  // then moves to the place where that chapter was left).
  const screen = route.name === 'reader' ? `reader:${route.id}` : route.name;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  if (route.name === 'reader') return <Reader key={route.id} id={route.id} />;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="WebTrad">
          <img src="./icon.svg" alt="" width={30} height={30} />
          <span>
            Web<b>Trad</b>
          </span>
        </a>
        <nav className="topnav">
          <a href="#/" className={route.name === 'library' ? 'active' : ''}>
            <Icon name="library" size={18} />
            <span>{t('nav.library')}</span>
          </a>
          <a href="#/new" className={route.name === 'new' ? 'active' : ''}>
            <Icon name="plus" size={18} />
            <span>{t('nav.new')}</span>
          </a>
          <a href="#/settings" className={route.name === 'settings' ? 'active' : ''}>
            <Icon name="settings" size={18} />
            <span>{t('nav.settings')}</span>
          </a>
        </nav>
      </header>
      <main className="content">
        {route.name === 'library' && <Library onNew={() => navigate('/new')} />}
        {route.name === 'new' && <NewChapter key={route.url ?? ''} initialUrl={route.url} />}
        {route.name === 'settings' && <SettingsPage />}
      </main>
      <footer className="footer">
        <span>WebTrad · {t('common.free')} · open source</span>
      </footer>
    </div>
  );
}
