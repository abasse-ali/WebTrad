import { useEffect } from 'react';
import { useT } from './i18n';
import { useSettings } from './lib/settings';
import { useRoute } from './router';
import { Icon } from './components/Icon';
import { Library } from './components/Library';
import { LogPage } from './components/LogPage';
import { QuickStatus } from './components/QuickImport';
import { NewChapter } from './components/NewChapter';
import { Reader } from './components/Reader';
import { SeriesPage } from './components/SeriesPage';
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
  const screen = route.name === 'reader' ? `reader:${route.id}` : route.name === 'series' ? `series:${route.key}` : route.name;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  if (route.name === 'reader') {
    return (
      <>
        <Reader key={route.id} id={route.id} />
        <QuickStatus />
      </>
    );
  }

  // Adding goes through the library's "+ Add" (and its sheet); the full
  // import screen stays reachable from there.
  const tab = route.name === 'settings' || route.name === 'log' ? 'settings' : 'library';
  const tabs = [
    { id: 'library', href: '#/', icon: 'library', label: t('nav.library') },
    { id: 'settings', href: '#/settings', icon: 'settings', label: t('nav.settings') },
  ] as const;

  return (
    <div className="app">
      {/* Wide screens: brand and tabs on top. Phones: tabs at the bottom, under the thumb. */}
      <header className="topbar">
        <a className="brand" href="#/" aria-label="WebTrad">
          <img src="./icon.svg" alt="" width={28} height={28} />
          <span>WebTrad</span>
        </a>
        <nav className="topnav">
          {tabs.map((x) => (
            <a key={x.id} href={x.href} className={tab === x.id ? 'active' : ''} aria-current={tab === x.id ? 'page' : undefined}>
              <Icon name={x.icon} size={18} />
              <span>{x.label}</span>
            </a>
          ))}
        </nav>
      </header>
      <main className={`content screen-${route.name}`}>
        {route.name === 'library' && <Library />}
        {route.name === 'series' && <SeriesPage key={route.key} seriesKey={route.key} />}
        {route.name === 'new' && <NewChapter key={route.key} initialUrl={route.url} handoff={route.handoff} />}
        {route.name === 'settings' && <SettingsPage />}
        {route.name === 'log' && <LogPage />}
      </main>
      <QuickStatus />
      <nav className="tabbar" aria-label="WebTrad">
        {tabs.map((x) => (
          <a key={x.id} href={x.href} className={tab === x.id ? 'active' : ''} aria-current={tab === x.id ? 'page' : undefined}>
            <Icon name={x.icon} size={22} />
            <span>{x.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
