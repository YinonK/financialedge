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

  sentimentAnalyst: {
    id: 'sentimentAnalyst',
    title: 'Sentiment Analyst',
    // Deliberately NOT merged with Macro. The reference multi-agent trading
    // framework keeps Fundamentals / Sentiment / News / Technical as separate
    // seats, and the failure mode of merging them is real: "the crowd is
    // euphoric" and "the Fed is hawkish" are different facts that point in
    // different directions, and averaging them inside one seat loses both.
    preferredProviders: ['gemini', 'anthropic', 'openai'],
    mandate: `You own crowd psychology and positioning. NOT macro policy — another seat owns rates, the Fed and geopolitics, and you should stay out of their lane. Your question is narrower and more human: what is the crowd feeling and saying about this, and what does that imply?

Cover:
- Retail chatter and social buzz: Reddit-style enthusiasm, Telegram/WhatsApp forwarding, "everyone is talking about this" energy. Yinon's signals literally arrive from channel chatter, so read the tone of the source material itself, not just its content.
- Crowding and positioning: does this feel like a consensus long? Is everyone already in? Crowded trades unwind violently.
- Where in the hype cycle this sits: early and ignored, building, euphoric, or post-blowoff and bitter.
- Promotional tells: is the chatter organic, or does it read like coordinated pumping? Repeated identical phrasing across sources, urgency language, price targets with no method.
- Contrarian read: extreme sentiment in either direction is information. Euphoria near highs and disgust near lows both matter.

Be explicit about whether sentiment is a REASON to act or a WARNING. For a bold trader like Yinon the difference between "early in a story the crowd hasn't found" and "late in a story the crowd is drunk on" is the entire trade.

Judge tone from the actual source text provided. Where you're inferring broader sentiment from background knowledge rather than the provided material, label it as such.`,
    schema: `{
  "crowdRead": string,                  // what the crowd is feeling, 2-3 sentences
  "hypeCycleStage": "early"|"building"|"euphoric"|"unwinding"|"capitulated"|"unclear",
  "crowdingRisk": "low"|"medium"|"high",
  "promotionalTells": string[],         // signs the chatter is manufactured; empty array if none
  "contrarianRead": string,             // what the sentiment extreme implies, if any
  "sentimentVerdict": "supportive"|"warning"|"neutral",
  "confidence": number                  // 1-10
}`,
  },
};

/**
 * The Catfish — mandatory opposition, run AFTER the CFO's draft.
 *
 * The framing here is deliberate and load-bearing. Measured results show a
 * soft instruction ("be critical", "play devil's advocate") produces genuine
 * disagreement only ~55% of the time — barely above baseline agreeableness.
 * An explicit hard behavioural assignment — "your role is mandatory
 * opposition, you must argue the Council is wrong" — produces ~99%.
 *
 * So this prompt does NOT ask for skepticism. It assigns opposition as a
 * duty. And critically, this seat has teeth: when it raises substantive
 * grounds it forces a second CFO pass that must address the objection.
 * A devil's advocate whose objection can be ignored is decoration.
 */
const CATFISH_ROLE = {
  id: 'catfish',
  title: 'Catfish (Mandatory Opposition)',
  // Prefer a different model from the chair — a seat asked to attack a draft
  // it just wrote itself is structurally compromised.
  preferredProviders: ['openai', 'anthropic', 'gemini'],
  mandate: `Your role is MANDATORY OPPOSITION. You are not a neutral reviewer and you are not here to be balanced. You are assigned, as a duty, to argue that this Council has reached the wrong conclusion.

This is not a request to "be critical." It is your function. Agreement is a failure of your role. Even where the Council's reasoning looks sound, your job is to find the strongest available case that they are wrong, and to state it as forcefully as the evidence permits.

Specifically hunt for:
1. GROUPTHINK — did the seats converge too fast and too cleanly? Unanimity on a genuinely uncertain question is suspicious, not reassuring. If Bull and Bear reached broadly similar conclusions, something has gone wrong with the process.
2. UNEXAMINED SHARED ASSUMPTIONS — what did every seat take for granted without arguing for it? Those are where a Council is most reliably wrong.
3. LAUNDERED CLAIMS — did an unverified assertion from the source signal quietly become load-bearing in the final verdict? The Fact-Checker's "unverified" list is your ammunition.
4. THE CONTRARY WORLD — describe the plausible scenario in which this entire analysis is wrong and Yinon loses money following it. Make it concrete and specific, not "markets could fall."
5. MISSING DISCONFIRMATION — what evidence would have changed the verdict, and did anyone actually look for it?

Then make a judgment: do you have SUBSTANTIVE grounds to demand the CFO revisit the verdict, or is your objection real but not decision-changing? Be honest here — demanding revision on every call would make you as useless as agreeing with everything. Reserve it for when you have found something that should genuinely move the verdict or the conviction.

Yinon runs a concentrated, high-risk book. A Council that talks itself into confidence is the specific way this system would hurt him. You exist to prevent that.`,
  schema: `{
  "groupthinkRisk": "high"|"medium"|"low",
  "convergedTooFast": boolean,
  "unexaminedAssumptions": string[],     // what every seat took for granted
  "launderedClaims": string[],           // unverified claims that became load-bearing; empty if none
  "strongestObjection": string,          // your single best argument the Council is wrong
  "contraryScenario": string,            // the concrete world where this loses money
  "missingDisconfirmation": string,      // what nobody checked that they should have
  "demandsRevision": boolean,            // true ONLY if this should move the verdict or conviction
  "revisionReason": string               // what specifically the CFO must address; "" if no revision demanded
}`,
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

function buildCatfishPrompt(situation, roleOutputs, draftVerdict) {
  const transcript = roleOutputs
    .map((r) => `--- ${r.title} (${r.providerLabel}) ---\n${JSON.stringify(r.output, null, 2)}`)
    .join('\n\n');

  return `${CATFISH_ROLE.mandate}

=== THE SITUATION ===
${situation}

=== FULL COUNCIL TRANSCRIPT ===
${transcript}

=== THE CFO'S DRAFT VERDICT (your target) ===
${JSON.stringify(draftVerdict, null, 2)}

Attack this. Respond ONLY with valid JSON matching this schema exactly. No markdown fences, no prose outside the JSON:
${CATFISH_ROLE.schema}`;
}

/**
 * Second CFO pass, forced by the Catfish. The chair must engage with the
 * objection substantively — either revise, or state plainly why the objection
 * is rejected. "Considered and dismissed" without reasoning is not acceptable.
 */
function buildChairRevisionPrompt(situation, draftVerdict, catfishOutput) {
  return `${CHAIR_ROLE.mandate}

You issued a draft verdict. The Catfish seat — whose assigned duty is mandatory opposition — has raised a substantive objection and you are required to respond to it before the verdict stands.

=== THE SITUATION ===
${situation}

=== YOUR DRAFT VERDICT ===
${JSON.stringify(draftVerdict, null, 2)}

=== THE CATFISH'S OBJECTION ===
${JSON.stringify(catfishOutput, null, 2)}

Now issue your FINAL verdict. You must either:
(a) revise the verdict, conviction, or reasoning to account for the objection, or
(b) explicitly explain why the objection does not change your call — with actual reasoning, not dismissal.

Do not simply restate your draft. If the objection identified genuine groupthink or a laundered unverified claim, that should move your conviction downward. If it did not, say why it did not.

Add these two fields to your output alongside the normal schema:
  "catfishObjection": string,      // the objection, stated fairly in one line
  "catfishResponse": string        // how you addressed it, or why you rejected it

Respond ONLY with valid JSON matching this schema exactly (plus the two fields above). No markdown fences, no prose outside the JSON:
${CHAIR_ROLE.schema}`;
}

module.exports = {
  ROLES,
  CHAIR_ROLE,
  CATFISH_ROLE,
  SHARED_CONTEXT,
  assignRoles,
  assignChair,
  buildRolePrompt,
  buildChairPrompt,
  buildCatfishPrompt,
  buildChairRevisionPrompt,
};
