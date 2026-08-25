renderSidebar('/signals.html');

async function addSignal() {
  const rawText = document.getElementById('f-text').value.trim();
  const source = document.getElementById('f-source').value.trim();
  if (!rawText) {
    showToast('Paste something first', 'error');
    return;
  }
  try {
    const item = await Api.post('/api/signals', { rawText, source });
    document.getElementById('f-text').value = '';
    document.getElementById('f-source').value = '';
    showToast(item.tickers.length ? `Detected: ${item.tickers.join(', ')}` : 'Saved (no tickers detected)');
    loadSignals();
    loadConvergence();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSignal(id) {
  try {
    await Api.del(`/api/signals/${id}`);
    loadSignals();
    loadConvergence();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadSignals() {
  const el = document.getElementById('signalsList');
  try {
    const items = await Api.get('/api/signals');
    if (!items.length) {
      el.innerHTML = `<div class="empty-state">No signals pasted yet.</div>`;
      return;
    }
    el.innerHTML = items
      .map(
        (item) => `
      <div class="signal-item">
        <div style="display:flex;justify-content:space-between;">
          <div class="dim" style="font-size:12px;">${new Date(item.pastedAt).toLocaleString()} · ${escapeHtml(item.source)}</div>
          <button class="btn secondary" style="padding:2px 8px;font-size:11px;" onclick="deleteSignal('${item.id}')">Delete</button>
        </div>
        <div style="margin:6px 0;font-size:13px;">${escapeHtml(item.rawText)}</div>
        <div>${item.tickers.map((t) => `<span class="ticker-chip">${t}</span>`).join('')}</div>
      </div>
    `
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load signals: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadConvergence() {
  const el = document.getElementById('convergence');
  try {
    const data = await Api.get('/api/signals/convergence/report');
    if (!data.convergences.length) {
      el.innerHTML = `<div class="empty-state">No ticker has 2+ signals in the last ${data.windowDays} days yet.</div>`;
      return;
    }
    el.innerHTML = data.convergences
      .map(
        (c) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
        <div><span class="ticker-chip">${c.ticker}</span> ${c.strongConvergence ? '<span class="badge buy">strong convergence</span>' : '<span class="badge watch">convergence</span>'}</div>
        <div class="dim" style="font-size:12px;">${c.count} mentions in ${data.windowDays}d</div>
      </div>
    `
      )
      .join('');
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load convergence report: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

(async function init() {
  loadSignals();
  loadConvergence();
})();
