import type { CapacitorConfig } from '@capacitor/cli';

// Native iOS wrapper. The web build in dist/ (models + WASM included) is
// bundled into the app, so it works fully offline with no server.
const config: CapacitorConfig = {
  appId: 'com.whwellbo.runform',
  appName: 'RunForm',
  webDir: 'dist',
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
