import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Inject the build asset list into dist/sw.js so the SW precaches everything. */
function swPrecachePlugin(): Plugin {
  return {
    name: 'tradelab-sw-precache',
    apply: 'build',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
      const assets = Object.values(manifest)
        .map((v: any) => `./${v.file}`)
        .concat([
          './manifest.webmanifest',
          './favicon.svg',
          './icon-192.png',
          './icon-512.png',
          './icon-maskable-512.png',
        ]);
      const swPath = resolve(dist, 'sw.js');
      let sw = readFileSync(swPath, 'utf8');
      // Replace the sentinel, NOT the comment. The comment keeps the human
      // note; only the runtime line gets the JSON array.
      const sentinel = "const PRECACHE = JSON.parse('__PRECACHE_ASSETS__');";
      const replacement = `const PRECACHE = ${JSON.stringify(assets)};`;
      if (!sw.includes(sentinel)) {
        throw new Error('sw precache sentinel not found');
      }
      sw = sw.replace(sentinel, replacement);
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), swPrecachePlugin()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    manifest: 'manifest.json',
  },
  server: {
    port: 5173,
  },
});
