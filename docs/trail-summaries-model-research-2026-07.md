# Trail Summaries — Model & Pricing Research (2026-07)

Research for Phase 2 "Trail summaries" (`docs/product-roadmap.md`). A cheap API model
writes one-line labels for clustered "episodes" of a project's revision trail.

- **Default mode (metadata-only):** changed paths, per-file change counts, timestamps,
  device name. ~300–900 input tokens, structured. File contents never leave the box.
- **Opt-in full-diff mode:** unified diffs, ~2k–8k input tokens.
- **Output:** one label ≤ ~25 tokens, plus an optional 1–2 sentence expansion ≤ ~80 tokens.
- **Volume:** solo dev ≈ 10 episodes/day (~300/mo); heavy team ≈ 100 episodes/day (~3000/mo).
- **Runs async, server-side.** Latency non-critical → **Batch APIs are usable** and are the
  right default here (50% off at the three major vendors).
- **Hard constraints:** opt-in, metadata-only default, vendor must contractually **not train
  on API data**; retention terms matter.

All prices verified against official vendor pages on **2026-07-12** (access date for every URL below).

---

## 0. The owner's two candidates — identified

Both "5.4 mini" and "5.6 Luna" are real, and both are **OpenAI** models. Neither is misremembered.

- **"5.4 mini" = OpenAI GPT-5.4 mini.** Released 2026-03-17. OpenAI's fast/cheap mid-tier
  (the tier below full GPT-5.4). $0.75 in / $4.50 out per 1M.
  ([OpenAI pricing](https://developers.openai.com/api/docs/pricing), accessed 2026-07-12)
- **"5.6 Luna" = OpenAI GPT-5.6 Luna.** The cheapest of the three-tier GPT-5.6 family
  (**Sol** flagship / **Terra** mid / **Luna** cheap), announced 2026-07-09. Luna is the
  "nano-class" tier for "cost-sensitive, high-volume workloads … summarization, drafting and
  routine automation." $1 in / $6 out per 1M.
  ([OpenAI: GPT-5.6](https://openai.com/index/gpt-5-6/),
  [Simon Willison](https://simonwillison.net/2026/Jul/9/gpt-5-6/), accessed 2026-07-12)
  - **Availability caveat:** initial coverage described a narrow (~20-org) preview, but
    OpenAI's own launch and multiple outlets report GA via API and Codex on 2026-07-09. It's
    the newest option here (3 days old at time of writing) — **confirm your account actually
    has API access before committing.**
    ([VentureBeat](https://venturebeat.com/technology/openai-unveils-gpt-5-6-sol-terra-and-luna-models-but-only-accessible-to-limited-preview-partners-for-now-per-us-gov),
    [QCode GA note](https://qcode.cc/en/gpt-5-6-guide), accessed 2026-07-12)

Note both are **OpenAI** — so the two owner picks share one vendor and one data policy. The
comparison below adds the three other requested classes: cheapest Anthropic small model,
cheapest Google Gemini flash-class, and a cheap open-weight-via-API option.

---

## 1. Comparison table

| Model | Vendor | $/M input | $/M output | Batch discount | Trains on API data? | Retention |
|---|---|---|---|---|---|---|
| **GPT-5.4 mini** | OpenAI | $0.75 | $4.50 | 50% (→ $0.375 / $2.25); cached in 10% | **No** (API not trained on by default) | ~30 days default; ZDR for eligible enterprise |
| **GPT-5.6 Luna** | OpenAI | $1.00 | $6.00 | 50% (→ $0.50 / $3.00); cached in 10% | **No** (same OpenAI API policy) | ~30 days default; ZDR for eligible enterprise |
| **Claude Haiku 4.5** | Anthropic | $1.00 | $5.00 | 50% (→ $0.50 / $2.50); cache read 10% | **No** (Commercial Terms bar training on customer content) | ≤30 days default; ZDR by contract |
| **Gemini 2.5 Flash-Lite** | Google | $0.10 | $0.40 | 50% (→ $0.05 / $0.20) | **No — on the PAID tier only** (free AI Studio tier DOES train) | Limited logging for abuse/legal; ZDR by approval |
| **DeepSeek V4 Flash** | DeepSeek | $0.14 | $0.28 | No batch API; off-peak ~50%; cache-hit in $0.0028 | **Paid API: not by default** (since Mar-2026 policy) — but **trains on free tier**, data stored **in China** | No fixed period; "as long as necessary" |

Sources (all accessed 2026-07-12):
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) ·
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) ·
[Anthropic data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) ·
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[Gemini ZDR](https://ai.google.dev/gemini-api/docs/zdr) ·
[OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) ·
[OpenAI enterprise privacy](https://openai.com/enterprise-privacy/) ·
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) ·
[DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)

### Data-policy detail (the load-bearing constraint)

- **OpenAI (both candidates):** API inputs/outputs are **not used to train** models by default;
  retained up to ~30 days for abuse monitoring then deleted; **Zero Data Retention** available
  to eligible enterprise accounts on approval, not on standard pay-as-you-go.
  ([enterprise privacy](https://openai.com/enterprise-privacy/),
  [data controls](https://developers.openai.com/api/docs/guides/your-data))
- **Anthropic (Haiku 4.5):** Commercial Terms state Anthropic **may not train** on customer
  content; API inputs/outputs default to deletion within ~30 days; **ZDR by contract**.
  Cleanest fit for a privacy-first product. ([retention docs](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention))
- **Google (Gemini Flash-Lite):** On the **paid** Gemini API / Vertex AI, prompts and responses
  are **not used to train** and are logged only briefly for abuse/legal; ZDR by approval.
  **Critical:** the **free AI Studio tier trains on your data and humans may review it** — HopIt
  must use a billed project. ([Gemini ZDR](https://ai.google.dev/gemini-api/docs/zdr),
  [paid-tier confirmation thread](https://discuss.ai.google.dev/t/is-my-data-used-for-training-or-retained-with-gemini-paid-api-calls/64837))
- **DeepSeek:** Per the Feb/Mar-2026 policy, paid API conversations are **not used for training
  by default**, but the free tier is, retention is open-ended, and **all data is stored on
  servers in the PRC** and subject to Chinese law (2017 National Intelligence Law can compel
  disclosure). This does not meet the spirit of HopIt's "vendor contractually won't train +
  retention matters" constraint. ([DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html))

---

## 2. Cost per episode and per user-month

**Token assumptions** (representative midpoints; label + short expansion):

- Metadata mode: **600 input / 50 output** tokens (range 300–900 in).
- Diff mode: **5,000 input / 60 output** tokens (range 2k–8k in).
- Solo dev = **300 episodes/mo**; heavy team = **3,000 episodes/mo**.

Cost/episode below is at **standard** rates; per-user-month columns show **standard** and
(**batch**, 50% off — the recommended async default). Gemini/DeepSeek are so cheap the numbers
round hard; figures carry enough digits to be meaningful.

### 2a. Metadata mode (the DEFAULT)

| Model | $/episode (std) | Solo/mo std | Solo/mo batch | Team/mo std | Team/mo batch |
|---|---|---|---|---|---|
| GPT-5.4 mini | $0.000675 | $0.20 | $0.10 | $2.03 | $1.01 |
| GPT-5.6 Luna | $0.00090 | $0.27 | $0.14 | $2.70 | $1.35 |
| Claude Haiku 4.5 | $0.00085 | $0.26 | $0.13 | $2.55 | $1.28 |
| Gemini 2.5 Flash-Lite | $0.00008 | $0.024 | $0.012 | $0.24 | $0.12 |
| DeepSeek V4 Flash | $0.000098 | $0.029 | ~$0.015 | $0.29 | ~$0.15 |

### 2b. Full-diff mode (opt-in)

| Model | $/episode (std) | Solo/mo std | Solo/mo batch | Team/mo std | Team/mo batch |
|---|---|---|---|---|---|
| GPT-5.4 mini | $0.00402 | $1.21 | $0.60 | $12.06 | $6.03 |
| GPT-5.6 Luna | $0.00536 | $1.61 | $0.80 | $16.08 | $8.04 |
| Claude Haiku 4.5 | $0.00530 | $1.59 | $0.80 | $15.90 | $7.95 |
| Gemini 2.5 Flash-Lite | $0.000524 | $0.16 | $0.08 | $1.57 | $0.79 |
| DeepSeek V4 Flash | $0.000717 | $0.22 | ~$0.11 | $2.15 | ~$1.08 |

Observations:

- **Default (metadata) mode, solo dev:** every model costs **≤ $0.27/user-month** at standard
  rates and **≤ $0.14 with batch**. Cost is noise.
- **Default mode, heavy team:** worst case (Luna) is **$2.70/mo std / $1.35 batch**. Still small.
- **Diff mode is where money appears:** heavy-team + diff on the OpenAI/Anthropic tier runs
  ~$6–8/user-month (batch). Here Gemini Flash-Lite (~$0.79) and DeepSeek (~$1.08) are ~8–10×
  cheaper. If diff mode ever becomes common on large teams, the cheap-tier gap starts to matter;
  for the opt-in-rare case it doesn't.

---

## 3. Recommendation

**At HopIt's default scale, the choice barely matters on cost — decide on quality and data policy.**

The default is metadata-only, opt-in. For a solo dev that's **≤ $0.14/user-month on any model
with batch**, and even a heavy team in default mode tops out under **$1.40/user-month**. That's
well under the "$0.05 doesn't move the needle" spirit for solo users and still trivial for teams.
So don't optimize the default for price.

**Recommended default: Claude Haiku 4.5**, accessed through a provider-agnostic interface (see §4),
with **Gemini 2.5 Flash-Lite as the pre-wired cheap fallback**.

Why Haiku for the default:

- **Policy is the cleanest.** Anthropic's Commercial Terms flatly bar training on customer
  content, ~30-day retention, ZDR by contract — the least-caveated fit for a privacy-first
  product with no "make sure you're on the paid tier" footgun (unlike Gemini's free/paid split).
- **Instruction-following pedigree.** Haiku-class models are well-benchmarked for terse,
  schema-constrained output; a ≤25-token label is trivially within range. (Task-specific evals
  for *this exact* labeling job are unverified — see quality notes — but the task is easy enough
  that all five candidates clear the bar.)
- Cost delta vs the cheapest option is **cents per user-month** in default mode.

Why keep Gemini 2.5 Flash-Lite wired as fallback:

- **~10× cheaper** and the one lever that matters *if* full-diff mode ever goes mainstream on
  big teams. Paid-tier policy is clean. Only caveat: you must run a **billed** project, never
  free AI Studio.

On the owner's two picks specifically:

- **GPT-5.4 mini** is the strongest of the sub-$1 OpenAI options and a fine choice — best
  instruction-following reputation in that price band, same clean OpenAI no-train policy.
  It's ~20% cheaper than Luna in metadata mode with no quality downside for this task.
- **GPT-5.6 Luna** works but is the **priciest option in the table for this workload** ($6/M
  output) with **no quality edge** at ≤25-token labeling, and it's 3 days old — availability
  and stability are unproven. If you want an OpenAI model, prefer **GPT-5.4 mini** over Luna
  for trail summaries. Reach for Luna only if you're already standardizing on the GPT-5.6 family
  elsewhere.
- **DeepSeek V4 Flash** is the cheapest frontier-small model and technically fine on the paid
  tier, but **excluded from the default recommendation on data-residency grounds** (PRC storage,
  open-ended retention, free-tier training). Not appropriate for a product whose whole pitch is
  invisible-but-private sync.

**Bottom line:** the money is negligible in the default configuration, so pick on policy →
**Haiku 4.5 default, Flash-Lite fallback**. GPT-5.4 mini is an equally defensible default if the
owner prefers OpenAI. Only revisit on cost if heavy teams turn diff mode on by default.

### Quality notes (instruction-following for terse structured labels)

- **GPT-5.6 Luna:** OpenAI reports **82.5%** on its instruction-following benchmark (vs Terra
  84.3, Sol 88.8), the family's cheap tier — more than adequate for one-line labels.
  ([Vellum](https://www.vellum.ai/blog/gpt-5-6-benchmarks-explained), accessed 2026-07-12)
- **GPT-5.4 mini:** OpenAI positions it for "high-throughput workloads and subagent
  orchestration," "approaching GPT-5.4 on reasoning/coding." No published head-to-head IF score
  vs the others for *this* task — **quality for terse labeling is unverified** but expected strong.
  ([BenchLM](https://benchlm.ai/compare/gemini-2-5-flash-vs-gpt-5-4-mini), accessed 2026-07-12)
- **Claude Haiku 4.5:** Anthropic's current small model; Haiku-class is well-regarded for
  structured/tool output. Task-specific eval unverified but the job is easy.
- **Gemini 2.5 Flash-Lite:** built for "high-volume, latency-sensitive" work; historically the
  lightest-weight of the frontier-small tier, but a ≤25-token label is well within reach. IF for
  this exact task is **unverified**. ([Gemini pricing/specs](https://ai.google.dev/gemini-api/docs/pricing), accessed 2026-07-12)
- **DeepSeek V4 Flash:** strong price/quality generally; not evaluated here for the label task
  because it's excluded on policy.

**Net:** for a ≤25-token label off structured metadata, all five are over-provisioned. Quality
differences at this task are unlikely to be user-visible, which reinforces deciding on policy/cost.

---

## 4. Abstraction note (one paragraph)

HopIt should call the summarizer through a **thin, provider-agnostic interface** — a single
`SummarizerProvider` with one method (`label(episode) -> {label, expansion?}`) plus a capability
flag for batch support — and keep all vendor specifics (model id, endpoint, auth, batch-job
submission/polling, price metadata) behind concrete adapters (`AnthropicProvider`,
`OpenAIProvider`, `GeminiProvider`). The prompt/response contract (input schema for metadata vs
diff mode, strict output shape, token caps) lives in the interface, not the adapter, so switching
models is a config change, not a code change. This matters concretely here: the pricing landscape
is moving weekly (GPT-5.6 shipped 3 days ago; Sonnet 5 pricing changes 2026-09-01), the eventual
"local model later" option in the roadmap is just another adapter, and the metadata-vs-diff
privacy switch is enforced at the interface boundary rather than trusted to each vendor's SDK.
Wire **Haiku 4.5 as the default adapter and Gemini Flash-Lite as a fallback** from day one so the
swap path is exercised, not theoretical.

---

## Sources (all accessed 2026-07-12)

- OpenAI API pricing — https://developers.openai.com/api/docs/pricing
- OpenAI GPT-5.6 launch — https://openai.com/index/gpt-5-6/
- OpenAI data controls — https://developers.openai.com/api/docs/guides/your-data
- OpenAI enterprise privacy — https://openai.com/enterprise-privacy/
- Simon Willison, GPT-5.6 family — https://simonwillison.net/2026/Jul/9/gpt-5-6/
- Vellum GPT-5.6 benchmarks — https://www.vellum.ai/blog/gpt-5-6-benchmarks-explained
- VentureBeat GPT-5.6 availability — https://venturebeat.com/technology/openai-unveils-gpt-5-6-sol-terra-and-luna-models-but-only-accessible-to-limited-preview-partners-for-now-per-us-gov
- Anthropic pricing — https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic API & data retention — https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Google Gemini API pricing — https://ai.google.dev/gemini-api/docs/pricing
- Google Gemini ZDR — https://ai.google.dev/gemini-api/docs/zdr
- Gemini paid-tier training confirmation — https://discuss.ai.google.dev/t/is-my-data-used-for-training-or-retained-with-gemini-paid-api-calls/64837
- DeepSeek API pricing — https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek privacy policy — https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- BenchLM Gemini 2.5 Flash vs GPT-5.4 mini — https://benchlm.ai/compare/gemini-2-5-flash-vs-gpt-5-4-mini
