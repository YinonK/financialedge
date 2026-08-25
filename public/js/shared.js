// Shared nav, localStorage<->server sync, formatting helpers, toast, and the
// indicator "?" popup used on Home. No build step — plain script tags, loaded
// on every page before the page's own js/<page>.js.

const NAV_ITEMS = [
  { href: '/index.html', label: 'Home' },
  { href: '/portfolio.html', label: 'Portfolio' },
  { href: '/research.html', label: 'Research' },
  { href: '/signals.html', label: 'Signals' },
  { href: '/journal.html', label: 'Journal' },
  { href: '/analyses.html', label: 'Analyses' },
  { href: '/brain.html', label: 'Brain Chat' },
  { href: '/settings.html', label: 'Settings' },
];

function renderSidebar(activeHref) {
  const el = document.getElementById('sidebar');
  if (!el) return;
  const links = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === activeHref ? 'active' : ''}">${item.label}</a>`
  ).join('');
  el.innerHTML = `
    <div class="brand">Financial<span>Edge</span></div>
    <nav>${links}</nav>
  `;
}

// NOTE: this file used to mirror the ENTIRE server context into localStorage
// on every page load. That made sense when the server had no durable disk;
// with Supabase it was just a multi-megabyte download per screen (full Council
// transcripts included) heading for the localStorage quota. Every screen loads
// what it needs from targeted endpoints now.
localStorage.removeItem('financialedge_context_v1'); // clean up the old mirror

// ---- Formatting ----
function fmtMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(n)) return '—';
  const symbol = currency === 'ILS' ? '₪' : '$';
  const sign = n < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
function pctClass(n) {
  if (n == null) return 'dim';
  return n > 0 ? 'pos' : n < 0 ? 'neg' : 'dim';
}

// ---- Toast ----
function showToast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ---- Indicator card + "?" help modal ----
function renderIndicatorCard(ind) {
  const statusClass = `status-${ind.status}`;
  let displayValue;
  if (ind.status === 'na') {
    displayValue = 'N/A';
  } else if (ind.id === 'fearGreed' || ind.id === 'us10y' || ind.id === 'dxy' || ind.id === 'vix') {
    displayValue = typeof ind.value === 'number' ? ind.value.toFixed(ind.id === 'us10y' ? 2 : 1) : '—';
  } else if (ind.id === 'gold' || ind.id === 'wti') {
    displayValue = typeof ind.value === 'number' ? fmtPct(ind.value) : '—';
  } else {
    displayValue = ind.value != null ? ind.value : '—';
  }

  return `
    <div class="indicator ${ind.category} ${statusClass === 'status-red' ? 'status-red' : ''}">
      <div class="label">
        <span>${ind.label}</span>
        <button class="help-btn" onclick="showIndicatorHelp('${ind.id}')">?</button>
      </div>
      <div class="value ${statusClass}">${displayValue}</div>
      ${ind.manualCheckHint ? `<div class="dim" style="font-size:11px;margin-top:4px;">${ind.manualCheckHint}</div>` : ''}
    </div>
  `;
}

let _lastIndicatorsById = {};

function setIndicatorLookup(indicators) {
  _lastIndicatorsById = {};
  indicators.forEach((i) => (_lastIndicatorsById[i.id] = i));
}

function showIndicatorHelp(id) {
  const ind = _lastIndicatorsById[id];
  if (!ind) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.onclick = (e) => {
    if (e.target === backdrop) backdrop.remove();
  };
  backdrop.innerHTML = `
    <div class="modal">
      <span class="close" onclick="this.closest('.modal-backdrop').remove()">✕</span>
      <h3>${ind.label}</h3>
      <p><strong>What it is:</strong> ${ind.explanation || 'n/a'}</p>
      <p><strong>How to read it:</strong> ${ind.howToRead || 'n/a'}</p>
      <p><strong>Why it matters to Yinon:</strong> ${ind.whyItMatters || 'n/a'}</p>
      <p><strong>Historical example:</strong> ${ind.historicalExample || 'n/a'}</p>
      ${ind.manualCheckHint ? `<p><strong>Manual check:</strong> ${ind.manualCheckHint}</p>` : ''}
    </div>
  `;
  document.body.appendChild(backdrop);
}
