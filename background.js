/**
 * Service Worker: realiza fetch a Yahoo Finance sin restricciones CORS.
 * El content script solicita datos vía mensaje; aquí hacemos la petición real.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

  return true; // Mantener canal abierto para respuesta async
});
