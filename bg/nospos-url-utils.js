/**
 * NosPos URL pattern utilities and storage helpers.
 * Globals: isNosposSearchPath, isNosposAgreementItemsUrl,
 *          isNosposNewAgreementWorkflowUrl, isNosposBuyingHubUrl,
 *          getPending, setPending
 */

function isNosposSearchPath(path) {
  return /^\/stock\/search(?:\/index)?\/?$/i.test((path || '').trim());
}

function isNosposAgreementItemsUrl(url) {
  try {
    var u = new URL(url || '');
    var host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'nospos.com' && !host.endsWith('.nospos.com')) return false;
    return /\/newagreement\/\d+\/items\/?$/i.test(u.pathname || '');
  } catch (e) {
    return false;
  }
}

function isNosposNewAgreementWorkflowUrl(url) {
  try {
    var u = new URL(url || '');
    var host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'nospos.com' && !host.endsWith('.nospos.com')) return false;
    return /\/newagreement\/\d+\//i.test(u.pathname || '');
  } catch (e) {
    return false;
  }
}

function isNosposBuyingHubUrl(url) {
  try {
    var u = new URL(url || '');
    var host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'nospos.com' && !host.endsWith('.nospos.com')) return false;
    return /^\/buying\/?$/i.test(u.pathname || '') || /^\/customer\/\d+\/buying\/?$/i.test(u.pathname || '');
  } catch (e) {
    return false;
  }
}

async function getPending() {
  var data = await chrome.storage.session.get('cgPending');
  return data.cgPending || {};
}

async function setPending(obj) {
  return chrome.storage.session.set({ cgPending: obj });
}
