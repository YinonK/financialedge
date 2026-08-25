renderSidebar('/journal.html');

async function loadScorecard() {
  const el = document.getElementById('scorecard');
  try {
    const s = await Api.get('/api/journal/scorecard');
    if (!s.totalDecisions) {
      el.innerHTML = `<div class="empty-state">No decisions logged yet. Log one below, or open a position on the Portfolio screen.</div>`;
      return;
    }

    const buckets = (title, obj) => {
      const keys = Object.keys(obj || {});
      if (!keys.length) return '';
      return `
        <div class="lens-block" style="margin-top:12px;">
          <h3>${title}</h3>
          <table style="margin-top:6px;">
            <thead><tr><th>Bucket</th><th>N</th><th>Hit rate</th><th>P&L</th></tr></thead>
            <tbody>
              ${keys
                .map(
                  (k) => `<tr>
                    <td>${escapeHtml(k)}</td>
                    <td>${obj[k].n}</td>
                    <td>${obj[k].hitRatePct != null ? obj[k].hitRatePct + '%' : '—'}</td>
                    <td class="${pctClass(obj[k].pnlUsd)}">${fmtMoney(obj[k].pnlUsd)}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>`;
    };

    el.innerHTML = `
      <div class="card-row">
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Closed decisions</div><div style="font-size:20px;font-weight:700;">${s.closedDecisions}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Hit rate</div><div style="font-size:20px;font-weight:700;">${s.hitRatePct != null ? s.hitRatePct + '%' : '—'}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Total P&L</div><div style="font-size:20px;font-weight:700;" class="${pctClass(s.totalPnlUsd)}">${fmtMoney(s.totalPnlUsd)}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Expectancy / decision</div><div style="font-size:20px;font-weight:700;" class="${pctClass(s.expectancyUsd)}">${s.expectancyUsd != null ? fmtMoney(s.expectancyUsd) : '—'}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Still open</div><div style="font-size:20px;font-weight:700;">${s.openDecisions}</div></div>
      </div>
      ${buckets('By conviction — does confidence predict anything?', s.byConviction)}
      ${buckets('By Council alignment — is a split Council a warning?', s.byCouncilAlignment)}
      ${buckets('By Council verdict', s.byCouncilVerdict)}
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load scorecard: ${escapeHtml(err.message)}</div>`;
  }
}

async function runReflection() {
  const el = document.getElementById('reflection');
  el.innerHTML = `<div class="empty-state">The Brain is reviewing its own record…</div>`;
  try {
    const res = await Api.post('/api/journal/reflect', {});
    el.innerHTML = `<div class="lens-block" style="margin-top:14px;border-color:var(--accent-gold);">
      <h3>Self-assessment</h3><p style="white-space:pre-wrap;">${escapeHtml(res.reflection)}</p></div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

async function loadEntries() {
  const el = document.getElementById('entries');
  try {
    const entries = await Api.get('/api/journal');
    if (!entries.length) {
      el.innerHTML = `<div class="empty-state">Nothing logged yet.</div>`;
      return;
    }
    el.innerHTML = entries.map(renderEntry).join('');
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load journal: ${escapeHtml(err.message)}</div>`;
  }
}

function renderEntry(e) {
  const o = e.outcome;
  const resultBadge = o
    ? o.result === 'win'
      ? '<span class="badge buy">WIN</span>'
      : o.result === 'loss'
      ? '<span class="badge avoid">LOSS</span>'
      : '<span class="badge watch">FLAT</span>'
    : '<span class="badge watch">OPEN</span>';

  const councilBit = e.council
    ? `<div class="dim" style="font-size:12px;margin-top:6px;">Council at the time: ${escapeHtml(e.council.verdict || '—')}${
        e.council.conviction != null ? ` · conviction ${e.council.conviction}/10` : ''
      }${e.council.alignment ? ` · ${escapeHtml(e.council.alignment)}` : ''}</div>`
    : '';

  return `
    <div class="card" style="background:var(--bg);margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <strong class="mono" style="font-size:15px;">${escapeHtml(e.ticker)}</strong>
          <span class="dim" style="margin-left:8px;">${escapeHtml(e.action)}${e.shares ? ` · ${e.shares}sh` : ''}${
    e.price != null ? ` @ ${fmtMoney(e.price)}` : ''
  }${e.conviction != null ? ` · your conviction ${e.conviction}/10` : ''}</span>
        </div>
        <div style="text-align:right;">
          ${resultBadge}
          ${o && o.pnlUsd != null ? `<div class="${pctClass(o.pnlUsd)}" style="font-weight:700;margin-top:4px;">${fmtMoney(o.pnlUsd)} (${fmtPct(o.pnlPct)})</div>` : ''}
        </div>
      </div>
      ${e.thesis ? `<div style="margin-top:8px;font-size:13px;">${escapeHtml(e.thesis)}</div>` : ''}
      ${councilBit}
      ${o && o.whatHappened ? `<div style="margin-top:6px;font-size:13px;"><strong>What happened:</strong> ${escapeHtml(o.whatHappened)}</div>` : ''}
      ${o && o.lesson ? `<div style="margin-top:4px;font-size:13px;"><strong>Lesson:</strong> ${escapeHtml(o.lesson)}</div>` : ''}
      <div class="dim" style="font-size:11px;margin-top:8px;">${new Date(e.ts).toLocaleString()} · ${escapeHtml(e.source)}</div>
      <div style="margin-top:10px;">
        ${e.status === 'open' ? `<button class="btn secondary" onclick="closeEntry('${e.id}')">Record outcome</button>` : ''}
        <button class="btn danger" onclick="deleteEntry('${e.id}')">Delete</button>
      </div>
    </div>`;
}

async function addEntry() {
  const body = {
    ticker: document.getElementById('f-ticker').value.trim(),
    action: document.getElementById('f-action').value,
    shares: document.getElementById('f-shares').value || null,
    price: document.getElementById('f-price').value || null,
    conviction: document.getElementById('f-conviction').value || null,
    thesis: document.getElementById('f-thesis').value.trim(),
  };
  if (!body.ticker) return showToast('Ticker is required', 'error');
  try {
    await Api.post('/api/journal', body);
    ['f-ticker', 'f-shares', 'f-price', 'f-conviction', 'f-thesis'].forEach((id) => (document.getElementById(id).value = ''));
    showToast('Decision logged');
    loadEntries();
    loadScorecard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function closeEntry(id) {
  const exitPrice = prompt('Exit price?');
  if (exitPrice == null) return;
  const whatHappened = prompt('What actually happened? (optional)') || '';
  const lesson = prompt('Lesson worth remembering? (optional)') || '';
  try {
    await Api.post(`/api/journal/${id}/outcome`, { exitPrice, whatHappened, lesson });
    showToast('Outcome recorded');
    loadEntries();
    loadScorecard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteEntry(id) {
  if (!confirm('Delete this journal entry? Your track record is only as useful as it is complete.')) return;
  try {
    await Api.del(`/api/journal/${id}`);
    loadEntries();
    loadScorecard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

(async function init() {
  loadScorecard();
  loadEntries();
})();
