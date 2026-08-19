renderSidebar('/index.html');

async function loadBriefing() {
  const el = document.getElementById('briefingContent');
  try {
    const history = await Api.get('/api/briefing/history');
    if (!history.length) {
      el.innerHTML = `<div class="empty-state">No briefing yet. cron-job.org will trigger one weekday mornings — see README to wire it up, or hit the endpoint manually to test.</div>`;
      return;
    }
    const latest = history[history.length - 1];
    el.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;margin:0;">${escapeHtml(latest.summary)}</pre>
      <div class="dim" style="margin-top:8px;font-size:11px;">${new Date(latest.ts).toLocaleString()}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load briefing history: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadPortfolioSnapshot() {
  const el = document.getElementById('portfolioSnapshot');
  try {
    const data = await Api.get('/api/portfolio');
    if (!data.positions.length) {
      el.innerHTML = `<div class="empty-state">No open positions yet. Add some on the <a href="/portfolio.html">Portfolio</a> screen.</div>`;
      return;
    }
    const rows = data.positions
      .map((p) => {
        const live = p.live || {};
        return `<tr>
          <td class="mono">${p.ticker}</td>
          <td>${p.side}</td>
          <td>${p.shares}</td>
          <td>${fmtMoney(p.entryPrice)}</td>
          <td>${live.currentPrice != null ? fmtMoney(live.currentPrice) : '—'}</td>
          <td class="${pctClass(live.pnlUsd)}">${live.pnlUsd != null ? fmtMoney(live.pnlUsd) : '—'}</td>
          <td class="${pctClass(live.pnlPct)}">${fmtPct(live.pnlPct)}</td>
          <td class="${pctClass(live.pnlIls)}">${live.pnlIls != null ? fmtMoney(live.pnlIls, 'ILS') : '—'}</td>
        </tr>`;
      })
      .join('');
    el.innerHTML = `
      <table>
        <thead><tr><th>Ticker</th><th>Side</th><th>Shares</th><th>Entry</th><th>Now</th><th>P&L $</th><th>P&L %</th><th>P&L ₪</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:12px;" class="dim">
        Total: <span class="${pctClass(data.totalPnlUsd)}">${fmtMoney(data.totalPnlUsd)}</span>
        &nbsp;/&nbsp;
        <span class="${pctClass(data.totalPnlIls)}">${data.totalPnlIls != null ? fmtMoney(data.totalPnlIls, 'ILS') : '—'}</span>
        &nbsp;·&nbsp; ${data.count}/${data.maxPositions} positions
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load portfolio: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadIndicators() {
  const grid = document.getElementById('indicatorsGrid');
  const alertEl = document.getElementById('confluenceAlert');
  try {
    const data = await Api.get('/api/market/indicators');
    setIndicatorLookup(data.indicators);
    grid.innerHTML = data.indicators.map(renderIndicatorCard).join('');
    if (data.confluenceAlert) {
      alertEl.innerHTML = `<div class="confluence-alert">⚠ Confluence alert: ${data.redCount} indicators are flashing red at once. Worth a deliberate look before doing anything today.</div>`;
    } else {
      alertEl.innerHTML = '';
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Couldn't load indicators: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadOpsStatus() {
  const el = document.getElementById('opsStatus');
  try {
    const [health, watchdogHistory] = await Promise.all([
      Api.get('/api/health'),
      Api.get('/api/watchdog/history'),
    ]);
    const lastWatchdog = watchdogHistory.length ? watchdogHistory[watchdogHistory.length - 1] : null;
    const actionableFlags = lastWatchdog ? lastWatchdog.flags.filter((f) => f.severity !== 'info') : [];

    const providerRows = (health.providerHealth || [])
      .map((p) => {
        const badge =
          p.status === 'ok'
            ? '<span class="pos">● working</span>'
            : p.status === 'failing'
            ? '<span class="neg">● failing</span>'
            : p.status === 'untested'
            ? '<span class="dim">○ configured, not yet used</span>'
            : '<span class="dim">○ not configured</span>';
        const detail = p.status === 'failing'
          ? `<div class="neg" style="font-size:11px;margin-top:4px;">${escapeHtml(p.lastError || '')}</div>
             ${p.hint ? `<div class="dim" style="font-size:11px;margin-top:2px;">→ ${escapeHtml(p.hint)}</div>` : ''}`
          : '';
        return `<tr><td>AI provider — ${escapeHtml(p.label)}</td><td>${badge}${detail}</td></tr>`;
      })
      .join('');

    const workingCount = (health.providerHealth || []).filter((p) => p.configured && p.status !== 'failing').length;
    const configuredCount = (health.providerHealth || []).filter((p) => p.configured).length;
    const councilLine =
      configuredCount === 0
        ? '<span class="neg">no AI provider configured</span>'
        : workingCount >= 2
        ? `<span class="pos">● negotiating across ${workingCount} models</span>`
        : workingCount === 1
        ? '<span class="dim">single voice — add/repair a second provider for negotiation</span>'
        : '<span class="neg">● all providers failing</span>';

    el.innerHTML = `
      <table>
        <tbody>
          <tr><td>The Council</td><td>${councilLine}</td></tr>
          ${providerRows}
          <tr><td>Telegram outbound (alerts + chat)</td><td>${statusPill(health.telegramOutboundConfigured)}</td></tr>
          <tr><td>Telegram channel ingestion</td><td>${statusPill(health.telegramIngestConfigured)}${health.telegramIngestChannels.length ? ` <span class="dim">(${health.telegramIngestChannels.join(', ')})</span>` : ''}</td></tr>
          <tr><td>Portfolio watchdog — last run</td><td>${lastWatchdog ? `${new Date(lastWatchdog.ts).toLocaleString()} · ${actionableFlags.length ? actionableFlags.length + ' flag(s)' : 'all clear'}` : '<span class="dim">no runs yet — needs cron-job.org wired up</span>'}</td></tr>
        </tbody>
      </table>
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load ops status: ${escapeHtml(err.message)}</div>`;
  }
}

function statusPill(configured) {
  return configured ? '<span class="pos">● configured</span>' : '<span class="dim">○ not configured</span>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

(async function init() {
  await syncContextFromServer();
  loadBriefing();
  loadPortfolioSnapshot();
  loadIndicators();
  loadOpsStatus();
})();
