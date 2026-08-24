renderSidebar('/settings.html');

let currentSettings = null;
let costData = null;

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

const PATH_LABELS = {
  research: 'Research (when you look up a ticker yourself)',
  opportunityHunt: 'Daily opportunity hunt',
  convergence: 'Signal convergence alerts',
  positionReview: 'Position re-checks',
};

async function loadCosts() {
  const el = document.getElementById('costs');
  try {
    costData = await Api.get('/api/settings/costs');
    const c = costData;
    const barPct = Math.min(100, c.percentOfCeiling || 0);
    const barColor = c.projectedOverCeiling ? 'var(--accent-red)' : barPct > 80 ? 'var(--accent-gold)' : 'var(--accent-green)';

    const providerRows = Object.entries(c.byProvider || {})
      .map(
        ([pid, b]) =>
          `<tr><td>${esc(pid)}</td><td>${b.calls}</td><td>${(b.inputTokens / 1000).toFixed(0)}k in / ${(b.outputTokens / 1000).toFixed(0)}k out</td><td>$${b.costUsd.toFixed(4)}</td></tr>`
      )
      .join('');

    el.innerHTML = `
      <div class="card-row">
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Spent so far</div><div style="font-size:22px;font-weight:700;">$${c.spentUsd.toFixed(2)}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">On track for</div><div style="font-size:22px;font-weight:700;color:${barColor};">$${c.projectedUsd.toFixed(2)}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Your limit</div><div style="font-size:22px;font-weight:700;">$${c.ceilingUsd}</div></div>
        <div class="card" style="background:var(--bg);"><div class="dim" style="font-size:11px;">Council runs</div><div style="font-size:22px;font-weight:700;">${c.runs}</div></div>
      </div>
      <div style="margin-top:12px;">
        <div style="height:10px;border-radius:6px;background:var(--bg);overflow:hidden;">
          <div style="height:100%;width:${barPct}%;background:${barColor};"></div>
        </div>
        <div class="dim" style="font-size:12px;margin-top:6px;">
          Day ${c.dayOfMonth} of ${c.daysInMonth}. ${
            c.projectedOverCeiling
              ? 'At this pace you would go over your limit this month.'
              : 'At this pace you stay inside your limit.'
          }
        </div>
      </div>
      ${providerRows ? `<table style="margin-top:14px;"><thead><tr><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${providerRows}</tbody></table>` : ''}
      ${
        (c.recentRuns || []).length
          ? `<details style="margin-top:12px;"><summary class="dim" style="cursor:pointer;font-size:12px;">Recent runs</summary>${c.recentRuns
              .map(
                (r) =>
                  `<div class="dim" style="font-size:12px;margin-top:4px;">${new Date(r.ts).toLocaleString()} — ${esc(
                    r.label
                  )} · $${r.totalUsd.toFixed(4)} · ${r.calls} calls</div>`
              )
              .join('')}</details>`
          : ''
      }`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state">Couldn't load spending: ${esc(err.message)}</div>`;
  }
}

function renderPaths() {
  const el = document.getElementById('paths');
  const paths = currentSettings.fullCouncilPaths || {};
  el.innerHTML = Object.keys(paths)
    .map(
      (key) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
        <input type="checkbox" id="path-${key}" ${paths[key] ? 'checked' : ''} style="width:auto;" />
        <label for="path-${key}" style="margin:0;color:var(--text);font-size:13px;">${esc(PATH_LABELS[key] || key)}</label>
      </div>`
    )
    .join('');
}

function renderPricing() {
  const el = document.getElementById('pricing');
  const defaults = (costData && costData.defaultPricing) || {};
  const overrides = (currentSettings && currentSettings.pricingOverrides) || {};
  el.innerHTML = Object.keys(defaults)
    .map((pid) => {
      const rate = overrides[pid] || defaults[pid];
      return `
        <div class="field-row">
          <div class="field"><label>${esc(pid)} — input $/1M</label><input id="price-${pid}-in" type="number" step="0.01" min="0" value="${rate.input}" /></div>
          <div class="field"><label>${esc(pid)} — output $/1M</label><input id="price-${pid}-out" type="number" step="0.01" min="0" value="${rate.output}" /></div>
        </div>`;
    })
    .join('');
}

async function loadSettings() {
  currentSettings = await Api.get('/api/settings');
  document.getElementById('s-budget').value = currentSettings.budgetCeilingUsd;
  document.getElementById('s-warn').value = String(currentSettings.budgetWarnFraction);
  document.getElementById('s-review-cadence').value = String(currentSettings.positionReviewCadenceDays);
  document.getElementById('s-hunt-candidates').value = String(currentSettings.opportunityHuntCandidates);
  renderPaths();
  renderPricing();
}

async function saveAll() {
  const note = document.getElementById('note');
  const fullCouncilPaths = {};
  Object.keys(currentSettings.fullCouncilPaths || {}).forEach((key) => {
    const cb = document.getElementById(`path-${key}`);
    if (cb) fullCouncilPaths[key] = cb.checked;
  });

  const pricingOverrides = {};
  Object.keys((costData && costData.defaultPricing) || {}).forEach((pid) => {
    const i = document.getElementById(`price-${pid}-in`);
    const o = document.getElementById(`price-${pid}-out`);
    if (i && o) pricingOverrides[pid] = { input: Number(i.value), output: Number(o.value) };
  });

  try {
    currentSettings = await Api.put('/api/settings', {
      budgetCeilingUsd: document.getElementById('s-budget').value,
      budgetWarnFraction: document.getElementById('s-warn').value,
      positionReviewCadenceDays: document.getElementById('s-review-cadence').value,
      opportunityHuntCandidates: document.getElementById('s-hunt-candidates').value,
      fullCouncilPaths,
      pricingOverrides,
    });
    note.textContent = 'Saved. Changes take effect on the next run — no need to change anything in cron-job.org.';
    showToast('Settings saved');
    loadCosts();
  } catch (err) {
    note.textContent = err.message;
    showToast(err.message, 'error');
  }
}

async function resetCosts() {
  if (!confirm("Reset this month's spend counter to zero? This only clears the estimate, it does not affect your real invoices.")) return;
  try {
    await Api.post('/api/settings/costs/reset', {});
    showToast('Spend counter reset');
    loadCosts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

(async function init() {
  await loadCosts();
  await loadSettings();
})();
