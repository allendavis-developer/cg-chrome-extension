/**
 * CeX navigation scrape — pure DOM parsing (no Chrome APIs).
 * Keeps listing / “Add from CeX” logic in content-listings.js; this module is only for
 * structured category discovery (super-categories from the header nav, future child levels).
 *
 * Exposes: globalThis.__cgCexNavParser.parseSuperCategories(root)
 */
(function initCexNavParser(global) {
  'use strict';

  var BASE = 'https://uk.webuy.com';

  function normalizeText(el) {
    if (!el) return '';
    return String(el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * @param {ParentNode} root - document or element containing the site header
   * @returns {{
   *   ok: boolean,
   *   code?: string,
   *   categories: Array<{
   *     id: string,
   *     label: string,
   *     href: string,
   *     superCatId: string | null,
   *     superCatNameFromQuery: string | null,
   *     path: string[],
   *     children: []
   *   }>,
   *   warnings?: string[]
   * }}
   */
  function parseSuperCategories(root) {
    var warnings = [];
    var ul = (root && root.querySelector && root.querySelector('ul.nav-menu')) || null;
    if (!ul) {
      return { ok: false, code: 'NAV_MENU_MISSING', categories: [], warnings: ['ul.nav-menu not found'] };
    }

    var categories = [];
    var lis = ul.querySelectorAll(':scope > li');

    lis.forEach(function (li) {
      var a = li.querySelector(':scope > a[href]');
      if (!a) return;

      var label = normalizeText(a.querySelector('span')) || normalizeText(a);
      if (!label) return;

      var hrefAttr = (a.getAttribute('href') || '').trim();
      var abs;
      try {
        abs = new URL(hrefAttr, BASE).href;
      } catch (e) {
        warnings.push('Skip invalid href: ' + hrefAttr);
        return;
      }

      var pathname = '';
      try {
        pathname = new URL(abs).pathname || '';
      } catch (e2) {
        pathname = '';
      }

      if (hrefAttr === '/' || (pathname === '/' && /^home$/i.test(label))) {
        return;
      }

      var superCatId = null;
      var superCatNameFromQuery = null;
      try {
        var u = new URL(abs);
        superCatId = u.searchParams.get('superCatId');
        superCatNameFromQuery = u.searchParams.get('superCatName');
      } catch (e3) {
        /* ignore */
      }

      var id = superCatId != null && String(superCatId) !== '' ? String(superCatId) : 'nav-' + categories.length;

      categories.push({
        id: id,
        label: label,
        href: abs,
        superCatId: superCatId,
        superCatNameFromQuery: superCatNameFromQuery,
        path: [label],
        children: [],
      });
    });

    if (categories.length === 0) {
      return {
        ok: false,
        code: 'NO_SUPER_CATEGORIES',
        categories: [],
        warnings: warnings.length ? warnings : ['nav-menu had no super-category links'],
      };
    }

    return { ok: true, categories: categories, warnings: warnings.length ? warnings : undefined };
  }

  global.__cgCexNavParser = { parseSuperCategories: parseSuperCategories };
})(typeof globalThis !== 'undefined' ? globalThis : window);
