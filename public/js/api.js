// Thin fetch wrapper. No API keys ever live here or in any browser code —
// every external data call (Yahoo, CNN, frankfurter, Gemini) happens server-side.
//
// The one secret the browser DOES hold is the app's own access key (APP_KEY on
// the server): asked for once, kept in localStorage, sent as X-App-Key on every
// request. Without it the API answers 401 to everyone — the app is personal.
const Api = (() => {
  const APP_KEY_STORAGE = 'financialedge_app_key';

  function getAppKey() {
    return localStorage.getItem(APP_KEY_STORAGE) || '';
  }

  function promptForKey(message) {
    const entered = window.prompt(message || 'Enter your FinancialEdge access key (APP_KEY):');
    if (entered && entered.trim()) {
      localStorage.setItem(APP_KEY_STORAGE, entered.trim());
      return true;
    }
    return false;
  }

  async function request(path, options = {}, isRetry = false) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(getAppKey() ? { 'X-App-Key': getAppKey() } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = text;
    }
    if (res.status === 401 && data && data.code === 'APP_KEY_REQUIRED' && !isRetry) {
      const had = getAppKey();
      const ok = promptForKey(
        had
          ? 'Your saved access key was rejected. Enter the current APP_KEY:'
          : 'This app is locked. Enter your access key (the APP_KEY value from Render):'
      );
      if (ok) return request(path, options, true);
    }
    if (!res.ok) {
      const message = (data && data.error) || `Request failed (HTTP ${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.code = data && data.code;
      throw err;
    }
    return data;
  }

  return {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body || {}) }),
    del: (path) => request(path, { method: 'DELETE' }),
  };
})();
