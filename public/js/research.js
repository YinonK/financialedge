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
      ${(b.verifiedFacts && b.verifiedFacts.length) || (b.unverifiedClaims && b.unverifiedClaims.length) ? `
      <div class="lens-grid" style="margin-top:14px;">
        <div class="lens-block" style="border-color:var(--accent-green);">
          <h3 style="color:var(--accent-green);">Verified against real data</h3>
          <p>${b.verifiedFacts && b.verifiedFacts.length ? b.verifiedFacts.map(escapeHtml).join('<br>• ') : 'nothing independently verified'}</p>
        </div>
        <div class="lens-block" style="border-color:var(--accent-gold);">
          <h3 style="color:var(--accent-gold);">Signal claims we could NOT verify</h3>
          <p>${b.unverifiedClaims && b.unverifiedClaims.length ? b.unverifiedClaims.map(escapeHtml).join('<br>• ') : 'none'}</p>
        </div>
      </div>` : ''}
      ${b.councilDisagreements && b.councilDisagreements.toLowerCase() !== 'none' ? `
      <div class="lens-block" style="margin-top:14px;border-color:var(--accent-purple);">
        <h3 style="color:var(--accent-purple);">Council disagreements ${b.councilAlignment ? `<span class="dim" style="font-size:11px;">(${escapeHtml(b.councilAlignment)})</span>` : ''}</h3>
        <p>${escapeHtml(b.councilDisagreements)}</p>
        ${b.catfishResponse ? `<p style="margin-top:8px;"><strong>After opposition:</strong> ${escapeHtml(b.catfishResponse)}</p>` : ''}
      </div>` : ''}
      ${b.watchDates && b.watchDates.length ? `<div class="dim" style="margin-top:12px;font-size:12px;">Watch dates: ${b.watchDates.map(escapeHtml).join(' · ')}</div>` : ''}
      ${b.suggestedNextStep ? `<div class="dim" style="margin-top:6px;font-size:12px;">Next step: ${escapeHtml(b.suggestedNextStep)}</div>` : ''}
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
  if (!c || !c.seats || !c.seats.length) return '';

  const seatCards = c.seats
    .map((s) => {
      const o = s.output || {};
      // Each seat has its own shape — show the line that matters most for it.
      const headline =
        o.thesis ||
        o.assessment ||
        o.regimeRead ||
        o.crowdRead ||
        o.reliabilityNote ||
        '';
      const verdictBits = [
        o.riskRewardVerdict ? `risk: ${o.riskRewardVerdict}` : null,
        o.macroVerdict ? `macro: ${o.macroVerdict}` : null,
        o.sentimentVerdict ? `sentiment: ${o.sentimentVerdict}` : null,
        o.overallReliability ? `source reliability: ${o.overallReliability}` : null,
        o.hypeCycleStage ? `hype cycle: ${o.hypeCycleStage}` : null,
        o.confidence != null ? `confidence ${o.confidence}/10` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      return `
      <div class="lens-block">
        <h3>${escapeHtml(s.title)} <span class="dim" style="font-size:11px;font-weight:400;">${escapeHtml(s.providerLabel)}</span></h3>
        ${headline ? `<p>${escapeHtml(headline)}</p>` : ''}
        ${verdictBits ? `<p class="dim" style="font-size:12px;margin-top:6px;">${escapeHtml(verdictBits)}</p>` : ''}
        <details style="margin-top:8px;">
          <summary class="dim" style="cursor:pointer;font-size:11px;">full seat output</summary>
          <pre style="font-size:11px;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(JSON.stringify(o, null, 2))}</pre>
        </details>
      </div>`;
    })
    .join('');

  const cat = c.catfish && c.catfish.output;
  const catfishBlock = cat
    ? `
    <div class="lens-block" style="margin-top:14px;border-color:var(--accent-purple);">
      <h3 style="color:var(--accent-purple);">Catfish — Mandatory Opposition <span class="dim" style="font-size:11px;font-weight:400;">${escapeHtml(c.catfish.providerLabel)}</span></h3>
      <p class="dim" style="font-size:12px;">Groupthink risk: <strong>${escapeHtml(cat.groupthinkRisk || '—')}</strong>${cat.convergedTooFast ? ' · converged too fast' : ''}${
        c.revisedAfterCatfish ? ' · <span class="pos">forced a CFO revision</span>' : cat.demandsRevision ? ' · demanded revision' : ' · no revision demanded'
      }</p>
      ${cat.strongestObjection ? `<p style="margin-top:6px;"><strong>Objection:</strong> ${escapeHtml(cat.strongestObjection)}</p>` : ''}
      ${cat.contraryScenario ? `<p style="margin-top:6px;"><strong>If we're wrong:</strong> ${escapeHtml(cat.contraryScenario)}</p>` : ''}
      ${cat.launderedClaims && cat.launderedClaims.length ? `<p style="margin-top:6px;" class="neg"><strong>Unverified claims doing real work:</strong> ${cat.launderedClaims.map(escapeHtml).join('; ')}</p>` : ''}
      <details style="margin-top:8px;">
        <summary class="dim" style="cursor:pointer;font-size:11px;">full opposition</summary>
        <pre style="font-size:11px;white-space:pre-wrap;overflow-x:auto;">${escapeHtml(JSON.stringify(cat, null, 2))}</pre>
      </details>
    </div>`
    : '';

  return `
    <div class="card">
      <h2>The Council <span class="dim" style="font-size:12px;font-weight:400;">— ${c.seats.length} specialized seats across ${c.providersUsed.length} model(s)${c.revisedAfterCatfish ? ', verdict revised after opposition' : ''}</span></h2>
      <div class="lens-grid">${seatCards}</div>
      ${catfishBlock}
      ${c.missingSeats && c.missingSeats.length ? `<div class="neg" style="margin-top:10px;font-size:11px;">⚠ Seats that failed to report: ${c.missingSeats.map(escapeHtml).join(', ')} — see Home → Brain Operations</div>` : ''}
      ${c.errors && c.errors.length ? `<div class="dim" style="margin-top:6px;font-size:11px;">Notes: ${c.errors.map(escapeHtml).join(' · ')}</div>` : ''}
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
})();
