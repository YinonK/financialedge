renderSidebar('/analyses.html');

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function verdictBadge(v) {
  if (!v) return '';
  const cls = v.toLowerCase();
  return `<span class="badge ${cls}">${esc(v)}</span>`;
}

function kindLabel(kind) {
  return (
    { research: 'Research', opportunity: 'Opportunity hunt', position_review: 'Position review', convergence: 'Signal convergence' }[
      kind
    ] || kind
  );
}

function seatSummary(seats) {
  if (!seats || !seats.length) return '';
  return seats
    .map((s) => `<span class="ticker-chip">${esc(s.title)} · ${esc((s.providerLabel || '').split(' ')[0])}</span>`)
    .join(' ');
}

function renderFull(a) {
  const v = a.verdict || {};
  const cat = a.catfish && a.catfish.output;
  return `
    <div class="card">
      <div class="verdict-panel">
        ${verdictBadge(v.verdict)}
        <div class="conviction-meter">${v.conviction != null ? v.conviction + '/10' : '—'} <span class="dim" style="font-size:12px;font-weight:400;">conviction</span></div>
        ${v.thesisStatus ? `<span class="badge ${v.thesisStatus === 'INTACT' ? 'buy' : v.thesisStatus === 'BROKEN' ? 'avoid' : 'watch'}">THESIS ${esc(v.thesisStatus)}</span>` : ''}
      </div>
      <h2 style="margin-top:8px;">${esc(a.ticker || (a.tickers || []).join(', '))} <span class="dim" style="font-size:12px;font-weight:400;">${kindLabel(a.kind)} · ${new Date(a.ts).toLocaleString()}</span></h2>
      ${v.headline ? `<p style="font-size:15px;">${esc(v.headline)}</p>` : ''}
      ${v.keyTakeaway ? `<p>${esc(v.keyTakeaway)}</p>` : ''}
      ${v.whatChangedSinceEntry ? `<p><strong>What changed since entry:</strong> ${esc(v.whatChangedSinceEntry)}</p>` : ''}

      <div class="lens-grid" style="margin-top:14px;">
        <div class="lens-block" style="border-color:var(--accent-green);">
          <h3 style="color:var(--accent-green);">Verified with real data</h3>
          <p>${(v.verifiedFacts || []).length ? (v.verifiedFacts || []).map(esc).join('<br>• ') : 'nothing independently verified'}</p>
        </div>
        <div class="lens-block" style="border-color:var(--accent-gold);">
          <h3 style="color:var(--accent-gold);">Could NOT verify</h3>
          <p>${(v.unverifiedClaims || []).length ? (v.unverifiedClaims || []).map(esc).join('<br>• ') : 'none'}</p>
        </div>
      </div>

      ${v.bullCase ? `<div class="lens-block" style="margin-top:14px;"><h3>Bull case</h3><p>${esc(v.bullCase)}</p></div>` : ''}
      ${v.bearCase ? `<div class="lens-block" style="margin-top:10px;"><h3>Bear case</h3><p>${esc(v.bearCase)}</p></div>` : ''}
      ${v.whatKillsThisTrade ? `<div class="lens-block" style="margin-top:10px;border-color:var(--accent-red);"><h3 style="color:var(--accent-red);">What kills this trade</h3><p>${esc(v.whatKillsThisTrade)}</p></div>` : ''}

      ${cat ? `
      <div class="lens-block" style="margin-top:14px;border-color:var(--accent-purple);">
        <h3 style="color:var(--accent-purple);">Catfish — mandatory opposition</h3>
        <p class="dim" style="font-size:12px;">Groupthink risk: ${esc(cat.groupthinkRisk || '—')}${a.revisedAfterCatfish ? ' · <span class="pos">forced a revision</span>' : ''}</p>
        ${cat.strongestObjection ? `<p style="margin-top:6px;"><strong>Objection:</strong> ${esc(cat.strongestObjection)}</p>` : ''}
        ${cat.contraryScenario ? `<p style="margin-top:6px;"><strong>If we're wrong:</strong> ${esc(cat.contraryScenario)}</p>` : ''}
        ${v.catfishResponse ? `<p style="margin-top:6px;"><strong>Chair's answer:</strong> ${esc(v.catfishResponse)}</p>` : ''}
      </div>` : ''}

      <div style="margin-top:14px;">${seatSummary(a.seats)}</div>

      <details style="margin-top:12px;">
        <summary class="dim" style="cursor:pointer;font-size:12px;">Full seat-by-seat transcript</summary>
        <pre style="font-size:11px;white-space:pre-wrap;overflow-x:auto;">${esc(JSON.stringify(a.seats, null, 2))}</pre>
      </details>

      <div class="dim" style="font-size:11px;margin-top:10px;">
        ${(a.providersUsed || []).join(', ')}${a.cost ? ` · cost $${(a.cost.totalUsd || 0).toFixed(4)} over ${a.cost.calls} calls` : ''}
        ${a.missingSeats && a.missingSeats.length ? ` · <span class="neg">missing seats: ${a.missingSeats.map(esc).join(', ')}</span>` : ''}
      </div>
      <div style="margin-top:8px;"><a href="/analyses.html">← back to all analyses</a></div>
    </div>`;
}

function renderRow(a) {
  const v = a.verdict || {};
  return `
    <div class="signal-item">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div>
          <strong class="mono">${esc(a.ticker || (a.tickers || []).join(', '))}</strong>
          ${verdictBadge(a.verdictLabel)}
          ${a.conviction != null ? `<span class="dim"> ${a.conviction}/10</span>` : ''}
          ${a.thesisStatus ? `<span class="dim"> · thesis ${esc(a.thesisStatus)}</span>` : ''}
          ${a.revisedAfterCatfish ? '<span class="dim"> · revised after opposition</span>' : ''}
          <div style="margin-top:4px;font-size:13px;">${esc(a.headline || a.keyTakeaway || '')}</div>
        </div>
        <div style="text-align:right;white-space:nowrap;">
          <div class="dim" style="font-size:11px;">${kindLabel(a.kind)}</div>
          <div class="dim" style="font-size:11px;">${new Date(a.ts).toLocaleDateString()}</div>
          <a href="/analyses.html?id=${encodeURIComponent(a.id)}" style="font-size:12px;">open</a>
        </div>
      </div>
    </div>`;
}

function renderTimeline(tl) {
  const card = document.getElementById('timelineCard');
  if (!tl.points.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  const e = tl.evolution;
  const summary = e
    ? `<p>${tl.ticker}: ${e.looks} looks. Conviction went ${e.convictionPath.join(' → ')} (${
        e.direction === 'warming' ? 'warming up' : e.direction === 'cooling' ? 'cooling off' : 'flat'
      }). Verdicts: ${e.verdictPath.join(' → ')}.</p>`
    : `<p>${tl.ticker}: one look so far.</p>`;

  const rows = tl.points
    .map(
      (p) => `<tr>
        <td>${new Date(p.ts).toLocaleDateString()}</td>
        <td>${kindLabel(p.kind)}</td>
        <td>${verdictBadge(p.verdict)}</td>
        <td>${p.conviction != null ? p.conviction + '/10' : '—'}</td>
        <td class="dim">${esc(p.headline || '')}</td>
        <td><a href="/analyses.html?id=${encodeURIComponent(p.id)}">open</a></td>
      </tr>`
    )
    .join('');

  const decisions = tl.decisions.length
    ? `<div style="margin-top:12px;"><strong>What you actually did:</strong>${tl.decisions
        .map(
          (d) =>
            `<div class="dim" style="font-size:12px;margin-top:4px;">${new Date(d.ts).toLocaleDateString()} — ${esc(
              d.action
            )}${d.price != null ? ` @ ${fmtMoney(d.price)}` : ''}${
              d.outcome ? ` → ${esc(d.outcome.result)} ${fmtMoney(d.outcome.pnlUsd)}` : ' (open)'
            }</div>`
        )
        .join('')}</div>`
    : '';

  document.getElementById('timeline').innerHTML = `
    ${summary}
    <table><thead><tr><th>Date</th><th>Type</th><th>Verdict</th><th>Conviction</th><th>Headline</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${decisions}`;
}

async function loadList() {
  const el = document.getElementById('list');
  const ticker = document.getElementById('f-ticker').value.trim();
  const kind = document.getElementById('f-kind').value;
  const verdict = document.getElementById('f-verdict').value;

  const qs = new URLSearchParams();
  if (ticker) qs.set('ticker', ticker);
  if (kind) qs.set('kind', kind);
  if (verdict) qs.set('verdict', verdict);

  try {
    const data = await Api.get(`/api/analyses?${qs.toString()}`);
    el.innerHTML = data.items.length
      ? `<div class="dim" style="font-size:12px;margin-bottom:8px;">${data.total} analysis(es)</div>${data.items.map(renderRow).join('')}`
      : `<div class="empty-state">No analyses yet. Run a Research call or wait for the next scheduled job.</div>`;

    if (ticker) {
      const tl = await Api.get(`/api/analyses/timeline/${encodeURIComponent(ticker)}`);
      renderTimeline(tl);
    } else {
      document.getElementById('timelineCard').style.display = 'none';
    }
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load analyses: ${esc(err.message)}</div>`;
  }
}

(async function init() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const ticker = params.get('ticker');

  if (id) {
    // Permalink view — a single debate.
    document.getElementById('filterCard').style.display = 'none';
    try {
      const a = await Api.get(`/api/analyses/${encodeURIComponent(id)}`);
      document.getElementById('permalink').innerHTML = renderFull(a);
      document.getElementById('list').closest('.card').style.display = 'none';
    } catch (err) {
      document.getElementById('permalink').innerHTML = `<div class="card"><div class="empty-state">${esc(err.message)}</div></div>`;
    }
    return;
  }

  if (ticker) document.getElementById('f-ticker').value = ticker;
  loadList();
})();
