/**
 * Service worker: fetches Yahoo Finance without page-level CORS restrictions.
 * The content script requests data through messaging; the actual request is made here.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'showOpportunityNotification') {
    const notificationId = `etoro-opportunity-${request.symbol || 'asset'}-${request.side || 'side'}`;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: request.title || 'eToro opportunity checklist',
      message: request.message || 'A trade setup reached the configured checklist threshold.',
      priority: 1
    });
    sendResponse({ ok: true });
    return false;
  }
  if (request.action !== 'fetchYahooChart') return false;

  (async () => {
    try {
      const { url } = request;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      sendResponse({ ok: true, data });
    } catch (err) {
      console.warn('[ATR Background]', err.message);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // Keep the channel open for the asynchronous response.
});
