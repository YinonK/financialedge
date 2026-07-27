renderSidebar('/research.html');

async function runResearch() {
  const ticker = document.getElementById('f-ticker').value.trim().toUpperCase();
  if (!ticker) {
    showToast('Enter a ticker', 'error');
    return;
  }
  const el = document.getElementById('results');
  el.innerHTML = `<div class="card"><div class="empty-state">Running the Five Lenses on ${ticker}… data feeds first, then the AI Council deliberates — can take up to a minute when multiple models negotiate.</div></div>`;

  try {
    const data = await Api.get(`/api/research/${ticker}`);
    el.innerHTML = renderResult(data);
  } catch (err) {
    el.innerHTML = `<div class="card"><div class="empty-state">Research failed: ${escapeHtml(err.message)}</div></div>`;
  }
}

function renderResult(data) {
  const b = data.brainAnalysis;
  const verdictHtml = b
    ? `
    <div class="card">
      <div class="verdict-panel">
        <span class="badge ${b.verdict ? b.verdict.toLowerCase() : ''}">${b.verdict || '—'}</span>
        <div class="conviction-meter">${b.conviction != null ? b.conviction + '/10' : '—'} <span class="dim" style="font-size:12px;font-weight:400;">conviction</span></div>
      </div>
      <div class="lens-grid">
        <div class="lens-block"><h3>Bull case</h3><p>${escapeHtml(b.bullCase || '')}</p></div>
        <div class="lens-block"><h3>Bear case</h3><p>${escapeHtml(b.bearCase || '')}</p></div>
      </div>
      <div class="lens-block" style="margin-top:14px;border-color:var(--accent-red);">
        <h3 style="color:var(--accent-red);">What kills this trade</h3>
        <p>${escapeHtml(b.whatKillsThisTrade || '')}</p>
      </div>
      ${b.disagreements ? `
      <div class="lens-block" style="margin-top:14px;border-color:var(--accent-purple);">
        <h3 style="color:var(--accent-purple);">Council disagreements ${b.councilAlignment ? `<span class="dim" style="font-size:11px;">(${escapeHtml(b.councilAlignment)})</span>` : ''}</h3>
        <p>${escapeHtml(b.disagreements)}</p>
      </div>` : ''}
    </div>
  `
    : `<div class="card"><div class="empty-state">${escapeHtml(data.brainError || 'The Brain did not return an analysis.')}</div></div>`;

  const councilHtml = renderCouncil(data.council);

  const lensesData = data.lenses;
  const fiveLensesReads = b && b.fiveLenses ? b.fiveLenses : {};

  const rawLensesHtml = `
    <div class="card">
      <h2>Five Lenses — raw data + Brain's read</h2>
      <div class="lens-grid">
        ${lensBlock('Valuation', fiveLensesReads.valuation, lensesData.valuation)}
        ${lensBlock('Technical Structure', fiveLensesReads.technicalStructure, lensesData.technicalStructure)}
        ${lensBlock('Macro & Geopolitics', fiveLensesReads.macroGeopolitics, lensesData.macroGeopolitics, true)}
        ${lensBlock('Flow & Sentiment', fiveLensesReads.flowSentiment, lensesData.flowSentiment)}
        ${lensBlock('Risk & Portfolio Fit', fiveLensesReads.riskPortfolioFit, lensesData.riskPortfolioFit)}
      </div>
    </div>
  `;

  return `<h2 style="margin-top:20px;">${data.ticker} <span class="dim" style="font-size:12px;font-weight:400;">as of ${new Date(data.generatedAt).toLocaleString()}</span></h2>${verdictHtml}${councilHtml}${rawLensesHtml}`;
}

function renderCouncil(c) {
  if (!c || !c.round1 || !c.round1.length) return '';
  const finalTakes = c.round2 || c.round1;
  const votes = finalTakes
    .map((r) => {
      const take = r.take || {};
      return `
      <div class="lens-block">
        <h3>${escapeHtml(r.label)}</h3>
        <p>
          <span class="badge ${take.verdict ? take.verdict.toLowerCase() : ''}">${escapeHtml(take.verdict || '—')}</span>
          <span class="dim" style="margin-left:8px;">conviction ${take.conviction != null ? take.conviction + '/10' : '—'}</span>
        </p>
        ${take.rebuttal ? `<p style="margin-top:8px;font-size:12px;"><strong>Rebuttal:</strong> ${escapeHtml(take.rebuttal)}</p>` : ''}
        <details style="margin-top:8px;">
          <summary class="dim" style="cursor:pointer;font-size:11px;">full take</summary>
          <pre style="font-size:11px;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(JSON.stringify(take, null, 2))}</pre>
        </details>
      </div>`;
    })
    .join('');

  return `
    <div class="card">
      <h2>The Council ${c.negotiated ? '<span class="dim" style="font-size:12px;font-weight:400;">— negotiated: independent takes, then rebuttals, then consensus</span>' : '<span class="dim" style="font-size:12px;font-weight:400;">— single voice (add a second AI key for negotiation)</span>'}</h2>
      <div class="lens-grid">${votes}</div>
      ${c.errors && c.errors.length ? `<div class="dim" style="margin-top:10px;font-size:11px;">Notes: ${c.errors.map(escapeHtml).join(' · ')}</div>` : ''}
    </div>
  `;
}

function lensBlock(title, read, rawData, isMacro) {
  const signal = read ? read.signal : null;
  const readText = read ? read.read : 'No narrative read (Gemini not configured or lens unavailable).';
  return `
    <div class="lens-block">
      <h3>${title} ${signal ? `<span class="dim" style="font-size:11px;">(${signal})</span>` : ''}</h3>
      <p>${escapeHtml(readText)}</p>
      <details style="margin-top:8px;">
        <summary class="dim" style="cursor:pointer;font-size:11px;">raw data</summary>
        <pre style="font-size:11px;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(JSON.stringify(isMacro ? summarizeMacro(rawData) : rawData, null, 2))}</pre>
      </details>
    </div>
  `;
}

function summarizeMacro(macro) {
  if (!macro || !macro.indicators) return macro;
  return {
    redCount: macro.redCount,
    watchCount: macro.watchCount,
    confluenceAlert: macro.confluenceAlert,
    indicators: macro.indicators.map((i) => ({ id: i.id, status: i.status, value: i.value })),
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

(async function init() {
  await syncContextFromServer();
})();
