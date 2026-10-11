'use strict';

// Websites sometimes share styles with their desktop apps. In a frameless
// Electron window, app-region:drag swallows clicks/hover and turns ordinary
// page controls into native title bars. Browsing content must never own the
// window's drag regions; those belong only to our trusted shell.
const PAGE_INPUT_CSS = '* { -webkit-app-region: no-drag !important; app-region: no-drag !important; }';
const configured = new WeakSet();
function configurePageContents(content) {
  if (configured.has(content)) return;
  configured.add(content);
  content.on('dom-ready', () => {
    if (content.isDestroyed()) return;
    // User origin outranks a site's author rules, including inline !important.
    // This stylesheet changes input hit testing only, not the site's appearance.
    content.insertCSS(PAGE_INPUT_CSS, { cssOrigin:'user' }).catch(error => {
      if (!content.isDestroyed()) console.error('Could not initialize page interactions:', error.message);
    });
  });
}
module.exports = { configurePageContents };
