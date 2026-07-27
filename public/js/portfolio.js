renderSidebar('/portfolio.html');

async function loadPositions() {
  const el = document.getElementById('positionsList');
  const cap = document.getElementById('capacityNote');
  try {
    const data = await Api.get('/api/portfolio');
    cap.textContent = `${data.count}/${data.maxPositions} positions used`;
    if (data.atCapacity) cap.classList.add('neg');

    if (!data.positions.length) {
      el.innerHTML = `<div class="empty-state">No open positions yet.</div>`;
      return;
    }

    el.innerHTML = data.positions
      .map((p) => {
        const live = p.live || {};
        const zone = live.zone;
        return `
        <div class="card" style="background:var(--bg);margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <strong class="mono" style="font-size:16px;">${p.ticker}</strong>
              <span class="dim" style="margin-left:8px;">${p.side} · ${p.shares} sh @ ${fmtMoney(p.entryPrice)}</span>
            </div>
            <div style="text-align:right;">
              <div class="${pctClass(live.pnlUsd)}" style="font-size:16px;font-weight:700;">${live.pnlUsd != null ? fmtMoney(live.pnlUsd) : '—'}</div>
              <div class="dim" style="font-size:12px;">${fmtPct(live.pnlPct)} · ${live.pnlIls != null ? fmtMoney(live.pnlIls, 'ILS') : '—'}</div>
            </div>
          </div>
          ${p.thesis ? `<div class="dim" style="margin-top:8px;font-size:13px;">${escapeHtml(p.thesis)}</div>` : ''}
          ${zone ? renderZoneBar(p, zone) : `<div class="dim" style="font-size:12px;margin-top:8px;">Set a stop + target to see the zone bar.</div>`}
          <div style="margin-top:10px;">
            <button class="btn secondary" onclick="editPosition('${p.id}')">Edit</button>
            <button class="btn danger" onclick="deletePosition('${p.id}')">Close / Delete</button>
          </div>
        </div>`;
      })
      .join('');
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load positions: ${escapeHtml(err.message)}</div>`;
  }
}

function renderZoneBar(p, zone) {
  const clampedPct = Math.max(0, Math.min(100, zone.pctToTarget));
  const label = zone.breachedStop
    ? `<span class="neg">Stop breached</span>`
    : zone.hitTarget
    ? `<span class="pos">Target hit</span>`
    : `${zone.pctToTarget.toFixed(0)}% of the way from stop to target`;
  return `
    <div style="margin-top:10px;">
      <div class="dim" style="font-size:11px;display:flex;justify-content:space-between;">
        <span>Stop ${fmtMoney(zone.stopPrice)}</span>
        <span>Target ${fmtMoney(zone.targetPrice)}</span>
      </div>
      <div class="zone-bar"><div class="marker" style="left:${clampedPct}%;"></div></div>
      <div style="font-size:12px;">${label}</div>
    </div>
  `;
}

async function addPosition() {
  const body = {
    ticker: document.getElementById('f-ticker').value.trim(),
    side: document.getElementById('f-side').value,
    shares: document.getElementById('f-shares').value,
    entryPrice: document.getElementById('f-entry').value,
    stopPrice: document.getElementById('f-stop').value || null,
    targetPrice: document.getElementById('f-target').value || null,
    thesis: document.getElementById('f-thesis').value.trim(),
  };
  if (!body.ticker || !body.shares || !body.entryPrice) {
    showToast('Ticker, shares, and entry price are required', 'error');
    return;
  }
  try {
    await Api.post('/api/portfolio', body);
    ['f-ticker', 'f-shares', 'f-entry', 'f-stop', 'f-target', 'f-thesis'].forEach((id) => (document.getElementById(id).value = ''));
    showToast(`${body.ticker.toUpperCase()} added`);
    loadPositions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deletePosition(id) {
  if (!confirm('Remove this position? This just removes it from FinancialEdge tracking — it does not touch your broker.')) return;
  try {
    await Api.del(`/api/portfolio/${id}`);
    showToast('Position removed');
    loadPositions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function editPosition(id) {
  const field = prompt('What do you want to update? Type one of: stopPrice, targetPrice, shares, thesis');
  if (!field) return;
  const value = prompt(`New value for ${field}:`);
  if (value == null) return;
  try {
    await Api.put(`/api/portfolio/${id}`, { [field]: value });
    showToast('Position updated');
    loadPositions();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

(async function init() {
  await syncContextFromServer();
  loadPositions();
})();
