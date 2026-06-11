import { initApp } from './ui.js';

window.addEventListener('DOMContentLoaded', () => {
  try {
    initApp();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:2em;color:#ff6b6b;font-family:monospace">
      <h2>Failed to start</h2><pre>${err.stack || err.message}</pre>
      <p>This app needs a browser with WebGL2 support.</p></div>`;
    throw err;
  }
});
