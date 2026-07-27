// Thin fetch wrapper. No API keys ever live here or in any browser code —
// every external data call (Yahoo, CNN, frankfurter, Gemini) happens server-side.
const Api = (() => {
  async function request(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = text;
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
