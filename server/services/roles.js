'use strict';

/**
 * Council roles — specialized adversarial seats, not five copies of the same
 * opinion.
 *
 * The multi-agent trading literature is consistent on one point: the
 * *coordination structure* drives quality more than the number of models.
 * Five models all asked "what do you think of NVDA?" converge on mush. Five
 * models each given an adversarial mandate — one paid to argue for, one paid
 * to argue against, one paid to find what kills it — surface disagreement
 * that a consensus prompt would have quietly averaged away.
 *
 * The Five Lenses (valuation, technical structure, macro & geopolitics, flow
 * & sentiment, risk & portfolio fit) are folded into each role's mandate as
 * the analytical checklist they draw on — not run as a separate pass.
 *
 * Role → provider mapping is a *preference*, not a requirement. Each role
 * names the providers best suited to it; if none are configured the role
 * falls back to whatever is available. That means the Council still works
 * with a single provider — the adversarial structure lives in the prompts,
 * so one model playing all seats is still meaningfully better than one model
 * asked for one opinion.
 *
 * READ-ONLY: every role recommends. None of them execute. Yinon trades.
 */

const SHARED_CONTEXT = `Yinon is an Israeli investor trading US equities. Bold, comfortable with high risk, macro-first thinker. Concentrated book of ~5 positions max, holding weeks to months. Tracks P&L in USD and ILS.

You are one seat on his investment Council. Play YOUR role fully and argue it honestly — another seat is arguing the opposite, and the synthesis depends on you making the strongest version of your case rather than hedging toward the middle.

Never instruct Yinon to place, modify, or close a trade. You analyze; he executes. Do not add disclaimers about financial advice — he knows what this is.

Where a number is not in the data provided, say it is unavailable. Never invent figures.`;

const ROLES = {
  bull: {
    id: 'bull',
    title: 'Bull Analyst',
    preferredProviders: ['anthropic', 'openai', 'gemini'],
    mandate: `You argue FOR. Build the strongest honest case that this is an opportunity worth Yinon's capital.

Draw on: valuation (is it actually cheap on P/E, PEG, EV/EBITDA, FCF yield — or just down?), technical structure (DMA posture, Fibonacci levels, RSI/MACD, volume confirmation), flow & sentiment (analyst revisions, short interest that could squeeze, insider buying), and the macro backdrop where it helps your case.

Be specific and falsifiable. "Strong fundamentals" is worthless; "FCF yield of X against a sector median of Y" is an argument. If the bull case is genuinely weak, say so plainly rather than manufacturing one — a fabricated bull case is worse than none.`,
    schema: `{
  "thesis": string,              // the core bull argument in 2-3 sentences
  "strongestPoints": string[],   // 2-4 specific, evidence-backed points
  "catalysts": string[],         // what could actually make this work, and roughly when
  "upsideScenario": string,      // realistic upside, with the reasoning
  "confidence": number           // 1-10, how strong the bull case genuinely is
}`,
  },

  bear: {
    id: 'bear',
    title: 'Bear Analyst',
    opposes: 'bull', // must not be the same model as the Bull seat when avoidable
    preferredProviders: ['anthropic', 'openai', 'gemini'],
    mandate: `You argue AGAINST. Build the strongest honest case that this is a trap, a value trap, already priced in, or simply not worth the risk.

Draw on: stretched valuation, deteriorating technical structure, negative divergences, macro headwinds, crowded positioning, insider selling, decaying fundamentals, competitive threats.

Your job is to find what the bull is glossing over. Be specific — "risks exist" is not bear analysis. If the bear case is genuinely thin, say so; do not manufacture doom.`,
    schema: `{
  "thesis": string,              // the core bear argument in 2-3 sentences
  "strongestPoints": string[],   // 2-4 specific, evidence-backed points
  "redFlags": string[],          // concrete warning signs present in the data
  "downsideScenario": string,    // realistic downside, with the reasoning
  "confidence": number           // 1-10, how strong the bear case genuinely is
}`,
  },

  riskManager: {
    id: 'riskManager',
    title: 'Risk Manager',
    preferredProviders: ['anthropic', 'openai', 'gemini'],
    mandate: `You own capital preservation, and your judgment carries veto weight in the final synthesis. You are not casting an equal vote — if you say the risk is unacceptable, the CFO must treat that as close to disqualifying regardless of how good the bull case sounds.

Cover:
- Position sizing off stop distance, capped at 2% of account equity at risk per trade
- Portfolio fit: this is a ~5-position concentrated book. Does adding this create dangerous correlation with what's already held? Is he doubling the same bet in different clothes?
- "What kills this trade" — the single specific condition that invalidates the thesis, stated so precisely that Yinon would know it when he sees it
- Where a stop actually belongs based on structure, not on a round number
- Whether the risk/reward geometry justifies the trade at all

Be the adult. A great story with an unmanageable stop is a bad trade.`,
    schema: `{
  "assessment": string,            // your overall read on the risk, 2-3 sentences
  "whatKillsThisTrade": string,    // the specific invalidation condition
  "suggestedStopLogic": string,    // where a stop belongs and why (structure-based)
  "correlationConcerns": string,   // vs the existing book; say "none" if genuinely none
  "riskRewardVerdict": "acceptable"|"marginal"|"unacceptable",
  "sizingNote": string,            // how to think about size given stop distance and the 2% cap
  "confidence": number             // 1-10 confidence in this assessment
}`,
  },

  factChecker: {
    id: 'factChecker',
    title: 'Fact-Checker',
    specialist: true,
    // GPT leads on hallucination-resistance in financial benchmarks, which is
    // precisely this seat's job.
    preferredProviders: ['openai', 'anthropic', 'gemini'],
    mandate: `You verify claims. Signals arriving from Telegram channels routinely contain specific numbers — dividend amounts and yields, production figures, revenue growth percentages, buyback sizes, guidance changes. Some are accurate. Some are stale. Some are wrong. Some are promotional.

Take every factual and numeric claim in the input and sort it into:
- VERIFIED: corroborated by the real market data provided in this prompt (price, technicals, valuation, fundamentals the app fetched itself)
- UNVERIFIED: plausible but nothing in the provided data confirms it — the app has no feed for it
- CONTRADICTED: the provided data disagrees with the claim, with the specific discrepancy named

Be pedantic. This is the seat that stops the Council from laundering a channel's marketing copy into an investment thesis. If a claim is central to the bull case and you cannot verify it, say so loudly — the CFO is required to keep verified and unverified separate in the final call.

Do not use outside knowledge to "verify" a number. Verified means confirmed by data in this prompt. Anything else is unverified, even if it sounds right.`,
    schema: `{
  "verified": [{ "claim": string, "evidence": string }],
  "unverified": [{ "claim": string, "whyUnverifiable": string }],
  "contradicted": [{ "claim": string, "discrepancy": string }],
  "overallReliability": "high"|"medium"|"low",
  "reliabilityNote": string   // one-line read on how much to trust this source
}`,
  },

  macroAnalyst: {
    id: 'macroAnalyst',
    title: 'Macro / Live-Web Analyst',
    specialist: true,
    // Gemini benchmarks best on live web-grounded context.
    preferredProviders: ['gemini', 'openai', 'anthropic'],
    mandate: `You own the top-down view — and critically, you are the seat that can say something useful when a signal has NO ticker at all (a Fed announcement, a bond market move, a tariff decision, a Bitcoin-treasury story with no equity attached).

Cover:
- Rates and the bond market: where yields are, what that does to equity multiples and to this name specifically
- Fed policy direction and what's priced in
- Dollar, gold, oil — and what they're signalling about risk appetite
- Crypto correlation where relevant (increasingly it is)
- Sector-wide and geopolitical context: tariffs, sanctions, supply chains, elections, conflict
- Whether the current macro regime is a tailwind or headwind for this specific idea

Yinon is macro-first — this seat often matters more to him than the single-name detail. If the macro backdrop makes an otherwise-good idea a bad idea right now, that is the headline.

Use the live indicator data provided. Where you are drawing on your own background knowledge rather than the provided data, label it as such so the CFO can weight it appropriately.`,
    schema: `{
  "regimeRead": string,            // what macro regime we're in right now, 2-3 sentences
  "ratesAndPolicy": string,
  "sectorAndGeopolitical": string,
  "implicationForThisIdea": string,
  "macroVerdict": "tailwind"|"headwind"|"neutral",
  "watchDates": string[],          // upcoming dated catalysts that matter (FOMC, deadlines, prints)
  "confidence": number             // 1-10
}`,
  },
};

const CHAIR_ROLE = {
  id: 'cfo',
  title: 'CFO',
  preferredProviders: ['anthropic', 'openai', 'gemini'],
  mandate: `You chair the Council and make the final call. You have the full record: the bull case, the bear case, the Risk Manager's assessment, the Fact-Checker's verification, and the Macro Analyst's read.

Rules for your synthesis:
1. The Risk Manager carries veto weight. If they returned "unacceptable", the verdict is AVOID or WATCH regardless of how compelling the bull case is. If "marginal", conviction must be capped low. You may overrule only with an explicit, stated reason.
2. You MUST keep verified facts separate from unverified signal claims. If the bull case leans on something the Fact-Checker could not verify, that has to be visible in your output, not buried. A thesis resting on unverified promotional numbers is not a thesis.
3. Where the seats genuinely disagreed, surface it. A split Council is information — never smooth it into false consensus. Disagreement should pull conviction down.
4. Conviction must be calibrated, not decorative. 9-10 means you would be surprised to be wrong. Most ideas are 4-7. Reserve the top of the range.
5. Be a sharp Wall Street friend: direct, specific, no filler, no disclaimers. Yinon executes every trade himself — never tell him to place one.`,
  schema: `{
  "headline": string,                    // one line Yinon could read and immediately get it
  "verdict": "BUY"|"WATCH"|"AVOID",
  "conviction": number,                  // 1-10, calibrated
  "keyTakeaway": string,                 // 2-3 sentences: the thing that actually matters
  "verifiedFacts": string[],             // what we actually confirmed with real data
  "unverifiedClaims": string[],          // what the signal asserted that we could NOT confirm
  "bullCase": string,
  "bearCase": string,
  "whatKillsThisTrade": string,
  "riskManagerVerdict": "acceptable"|"marginal"|"unacceptable",
  "macroVerdict": "tailwind"|"headwind"|"neutral",
  "councilDisagreements": string,        // where seats split and why it matters; "none" if genuinely unanimous
  "councilAlignment": "unanimous"|"majority"|"split",
  "watchDates": string[],                // dated catalysts worth putting in the calendar
  "suggestedNextStep": string            // e.g. "full Five Lenses on X", "wait for level Y", "nothing to do"
}`,
};

/**
 * Assigns each role to a provider.
 *
 * Two-pass, because naive "everyone gets their first choice" collapses the
 * adversarial design: Bull, Bear and Risk all prefer the same strong reasoner,
 * so all three land on one model and the bull/bear split becomes a model
 * arguing with itself.
 *
 *   Pass 1 — specialist seats (Fact-Checker, Macro Analyst) get their
 *            preferred provider. The whole reason they exist is that a
 *            specific model is better at that job.
 *   Pass 2 — generalist seats (Bull, Bear, Risk) are spread across the
 *            remaining providers, favouring ones not yet used, so opposing
 *            seats are argued by genuinely different models wherever the
 *            configured provider count allows.
 *
 * With one provider configured everything lands on it — still worthwhile,
 * since the adversarial structure lives in the prompts.
 */
function assignRoles(configuredProviders, roleIds) {
  const ids = roleIds || Object.keys(ROLES);
  const available = configuredProviders;
  if (!available.length) return [];

  const requested = ids.map((id) => ROLES[id]).filter(Boolean);
  const usageCount = new Map(available.map((p) => [p.id, 0]));
  const assignments = [];

  const specialists = requested.filter((r) => r.specialist);
  const generalists = requested.filter((r) => !r.specialist);

  for (const role of specialists) {
    const preferred = role.preferredProviders.map((pid) => available.find((p) => p.id === pid)).find(Boolean);
    const provider = preferred || available[0];
    usageCount.set(provider.id, usageCount.get(provider.id) + 1);
    assignments.push({ role, provider, usingPreferred: Boolean(preferred) });
  }

  for (const role of generalists) {
    // Prefer this role's ranked choices, but break toward whichever of them is
    // least loaded so opposing seats end up on different models.
    const candidates = role.preferredProviders
      .map((pid) => available.find((p) => p.id === pid))
      .filter(Boolean);
    let pool = candidates.length ? candidates : available;

    // Adversarial pairing: the seat arguing against should not be the same
    // model as the seat arguing for, whenever more than one provider exists.
    // Two models genuinely disagreeing is the entire point of the structure;
    // one model arguing with itself is theatre.
    if (role.opposes) {
      const opponent = assignments.find((a) => a.role.id === role.opposes);
      if (opponent) {
        const differing = pool.filter((p) => p.id !== opponent.provider.id);
        if (differing.length) pool = differing;
      }
    }

    const provider = pool.reduce((best, p) =>
      usageCount.get(p.id) < usageCount.get(best.id) ? p : best
    );
    usageCount.set(provider.id, usageCount.get(provider.id) + 1);
    assignments.push({
      role,
      provider,
      usingPreferred: role.preferredProviders.includes(provider.id),
    });
  }

  // Return in the declared role order for stable, readable output.
  return ids.map((id) => assignments.find((a) => a.role.id === id)).filter(Boolean);
}

function assignChair(configuredProviders, explicitChairId) {
  const available = configuredProviders;
  if (!available.length) return null;
  if (explicitChairId) {
    const forced = available.find((p) => p.id === explicitChairId);
    if (forced) return forced;
  }
  const preferred = CHAIR_ROLE.preferredProviders.map((pid) => available.find((p) => p.id === pid)).find(Boolean);
  return preferred || available[0];
}

function buildRolePrompt(role, situation) {
  return `${role.mandate}

=== THE SITUATION ===
${situation}

Respond ONLY with valid JSON matching this schema exactly. No markdown fences, no prose outside the JSON:
${role.schema}`;
}

function buildChairPrompt(situation, roleOutputs) {
  const transcript = roleOutputs
    .map((r) => `--- ${r.title} (${r.providerLabel}) ---\n${JSON.stringify(r.output, null, 2)}`)
    .join('\n\n');

  const missing = Object.values(ROLES)
    .filter((r) => !roleOutputs.some((o) => o.roleId === r.id))
    .map((r) => r.title);

  return `${CHAIR_ROLE.mandate}

=== THE SITUATION ===
${situation}

=== COUNCIL TRANSCRIPT ===
${transcript}
${missing.length ? `\nNOTE: these seats failed to report and are missing from the transcript: ${missing.join(', ')}. Account for the gap — do not pretend they agreed.` : ''}

Respond ONLY with valid JSON matching this schema exactly. No markdown fences, no prose outside the JSON:
${CHAIR_ROLE.schema}`;
}

module.exports = {
  ROLES,
  CHAIR_ROLE,
  SHARED_CONTEXT,
  assignRoles,
  assignChair,
  buildRolePrompt,
  buildChairPrompt,
};
