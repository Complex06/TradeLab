import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('SW registration failed', e);
    });
  });
}

// Ask the browser to persist IndexedDB storage (datasets/practice snapshots)
// so data isn't evicted under storage pressure — important on iOS Safari.
if (navigator.storage?.persist) {
  void navigator.storage.persist().catch(() => {
    // Best-effort: some browsers deny or prompt; the app still works.
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
