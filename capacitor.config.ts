import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.webtrad.reader',
  appName: 'WebTrad',
  webDir: 'dist',
  ios: {
    // Reading is done in a dark reader: avoid a white flash at launch.
    backgroundColor: '#0f0e14',
    contentInset: 'never',
  },
};

export default config;
