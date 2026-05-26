import { defineConfig } from 'vite';
import precacheManifest from './vite-plugins/precache-manifest.js';

export default defineConfig({
  base: './',
  plugins: [precacheManifest()],
});
