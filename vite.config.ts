import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Electron loads the built app from file://, which needs relative asset URLs.
  base: process.env.ELECTRON ? './' : '/',
  plugins: [react()],
  server: { host: true },
});
