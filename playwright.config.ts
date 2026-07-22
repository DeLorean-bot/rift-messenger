import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  // Pairing intentionally exercises public Nostr relays. A relay can be
  // temporarily slow even when the product and WebRTC path are healthy.
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://127.0.0.1:4174',
    channel: 'msedge',
    headless: true,
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: true,
  },
});
