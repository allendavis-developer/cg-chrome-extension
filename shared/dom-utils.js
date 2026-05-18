/**
 * Shared DOM utilities for CG Suite content scripts.
 * Loaded before content scripts via manifest.json content_scripts[].js arrays.
 */

var CG_DOM_UTILS = (function () {
  'use strict';

  function ensureCgSuiteInter() {
    if (document.getElementById('cg-suite-font-inter')) return;
    var link = document.createElement('link');
    link.id = 'cg-suite-font-inter';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap';
    (document.head || document.documentElement).appendChild(link);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeDomText(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  return { ensureCgSuiteInter, escapeHtml, normalizeDomText };
})();
