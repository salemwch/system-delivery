# AI & Machine Learning Strategy

> ## ⛔ DEFERRED — NOT PART OF THE CURRENT PLAN
>
> **Decision (2026-07-22): no AI or ML will be built into the system for now.**
>
> This document is retained as **future reference only**. Nothing in it is scheduled, and no AI/ML work should be started, scaffolded, or designed into features without an explicit new decision reversing this.
>
> **What still applies today:** the *data-quality* requirements in §10 — `occurred_at` vs `recorded_at`, plan-vs-actual capture, and structured failure reason codes. These are **independently justified** by SLA measurement, operational reporting, and re-attempt workflows ([01-mvp-scope.md §4.7](./01-mvp-scope.md#47-foundations-carried-despite-no-immediate-payoff)); they are not AI work. They also happen to keep this option open at zero extra cost, which is the only reason this document is kept rather than deleted.
>
> **Non-ML substitutes already in the plan:** OSRM baseline ETAs, historical-median service time (a SQL query, not a model), and rule-based fraud flags — see [01-mvp-scope.md](./01-mvp-scope.md).

> Covers **Phase 8** of the original brief.
> Parent: [architecture-blueprint.md](./architecture-blueprint.md)
> **Status:** DEFERRED INDEFINITELY.

---

## 1. Philosophy

**Three rules govern every AI feature in this platform.**

**Rule 1 — Every model must beat a stated baseline, measured in production, or it is deleted.**
Each feature below declares its heuristic baseline and the margin by which the model must beat it. "The model is live" is not a success criterion; "the model reduced ETA MAE from 11.4 to 6.8 minutes on held-out production traffic" is.

**Rule 2 — The platform must be fully functional with `ml-service` down.**
Every prediction has a documented, always-available fallback. AI is an *enhancement layer*, never a dependency of a business flow. A dispatcher must be able to run the day's operation with every model offline.

**Rule 3 — Start with gradient-boosted trees on tabular data. Escalate only with evidence.**
Every problem here — ETA, delay risk, fraud, demand — is tabular regression or classification with strong engineered features. LightGBM/XGBoost dominate this data shape, train in minutes on commodity hardware, and are interpretable enough to debug and to defend to a customer. Deep learning is justified only when a documented experiment shows the tree model plateauing below requirements.

**What we are explicitly not building:** an LLM chatbot as a headline feature. "Ask your logistics data anything" demos well and is used approximately never. LLMs appear in exactly three narrow, bounded places in §9, where they solve a real language problem.

---

## 2. Feature Portfolio & Sequencing

| # | Feature | Business value | Difficulty | Data needed before it works | Phase |
|---|---|---|---|---|---|
| 1 | **ETA prediction** | Highest — drives customer trust, support-call volume, and failed-delivery rate | Medium | 3 months / ~50k completed deliveries | **V2** |
| 2 | **Service-time prediction** | High — the largest single error source in route plans | Low | 2 months / ~20k stops | **V2** |
| 3 | **Delivery delay / failure risk** | High — enables proactive intervention before the customer notices | Medium | 3 months, with failure labels | **V2** |
| 4 | **COD & POD fraud detection** | Very high where COD dominates — direct financial loss prevention | Medium | Rules from day one; ML at 6 months | **V2 (rules at MVP)** |
| 5 | **Smart dispatch (learned assignment weights)** | High — compounding operational efficiency | High | 6 months of assignment outcomes | **V3** |
| 6 | **Demand forecasting** | Medium-high — staffing and fleet planning | Medium | 12 months (seasonality requires a full cycle) | **V3** |
| 7 | **Driver performance analytics** | Medium — but **highest ethical risk**; see §8 | Low | 3 months | **V2 (descriptive only)** |
| 8 | **Address normalisation & geocode repair** | High — quietly determines routing and ETA quality | Low-Medium | Immediate (rules + external APIs) | **MVP (non-ML), V2 (ML)** |

**Sequencing rationale:** ML features are deliberately absent from MVP. Not because they are unimportant — ETA prediction is arguably the platform's most valuable capability — but because **they require historical data that does not exist yet**. The MVP's real ML deliverable is *instrumenting the data collection correctly* so that V2 models have clean, labelled, leak-free training data. Getting this wrong costs 6 months of unusable history.

---

## 3. ETA Prediction

**The single highest-value model.** ETA accuracy determines customer trust, "where is my order?" support volume, and failed-delivery rate (a customer who leaves because the ETA said 14:00 and the driver arrives at 17:30 is a failed delivery caused by a model, not by logistics).

### Approach — predict the *residual*, not the ETA

Do **not** train a model to predict arrival time from scratch. Train it to predict the **error of the routing engine's estimate**:

```
final_eta = osrm_baseline_duration + model_predicted_residual + predicted_service_time_of_preceding_stops
```

Why this is materially better:
- OSRM already solves the hard physical problem (road network, distances, speed limits). Re-learning road topology from delivery data is wasteful and needs orders of magnitude more data.
- The residual is a small, well-behaved, near-zero-centred target — far easier to learn than absolute duration.
- **It degrades gracefully.** With the model off, `final_eta = osrm_baseline` — still a usable ETA. This is Rule 2 in practice.
- Residual magnitude is itself a monitoring signal: if residuals drift, something changed in the real world (new traffic pattern, new depot, seasonal effect).

### Features

| Category | Features |
|---|---|
| Route context | stops remaining, distance to stop, stops completed today, current schedule delta vs plan |
| Temporal | hour of day, day of week, is-holiday, days-to-holiday, month |
| Spatial | origin/destination zone, urban density class, historical median speed on the corridor (from `zone_traffic_1h`) |
| Driver | driver's historical speed factor vs plan, tenure, zone familiarity |
| Stop | address type (residential/commercial/apartment/gated), historical service time at **this exact address**, access notes present, floor/elevator flags |
| Package | item count, weight, volume, requires-signature, requires-COD (COD adds real handling time) |
| Live | current traffic factor, weather (precipitation, temperature, visibility), driver's current speed |
| Recent | rolling residual of this driver's last 5 stops — captures "running late today" |

**Highest-value feature, empirically:** historical service time at the specific address. A gated compound or a 6th-floor walk-up costs 8 extra minutes every single time, and no routing engine knows this. It is learnable only from our own delivery history — which is why it is a durable competitive advantage rather than something a competitor can buy.

### Model, training, serving

- **Model:** LightGBM regression, quantile objective. We predict **P10/P50/P90**, not a point estimate, so the customer sees a *window* ("arriving 14:10–14:40") calibrated to real uncertainty. Point ETAs are dishonest and generate complaints.
- **Training:** nightly batch on 90 days of completed deliveries. **Per-tenant models where a tenant has >20k deliveries; otherwise a pooled global model with `tenant_id` as a categorical feature** — this solves the cold-start problem for new tenants.
- **Validation:** strict **time-based split** (train on weeks 1–10, validate on weeks 11–12). Random k-fold leaks future information into the past and produces models that look excellent offline and fail in production. This is the most common and most expensive ML mistake in operational forecasting.
- **Serving:** gRPC `PredictEta`, p99 <100 ms. Predictions cached in Valkey keyed by `(route_id, stop_sequence)`, invalidated on any route or position change.
- **Refresh cadence:** on route publish, on each stop completion, on significant traffic change, and at least every 10 minutes for in-transit shipments.

### Success criteria

| Metric | Baseline (OSRM alone) | Model target |
|---|---|---|
| Mean absolute error | ~12–15 min (typical) | **<7 min** |
| P90 absolute error | ~35 min | **<18 min** |
| % arrivals within the promised window | ~65 % | **>85 %** |
| Window calibration (actual coverage of P10–P90) | — | **88–92 %** (an 80 % window that covers 60 % is worse than useless) |

**Guardrail:** if MAE exceeds the baseline for 3 consecutive days on any tenant, auto-fallback to the baseline for that tenant and alert. Models fail silently; the system must not.

---

## 4. Service-Time Prediction

Frequently overlooked, often the **largest error source** in route plans. Solvers assume a fixed service time per stop (commonly 3–5 minutes). Reality ranges from 45 seconds (mailbox drop) to 20 minutes (gated compound, freight elevator, COD counting, signature).

- **Baseline:** per-tenant global constant.
- **Better baseline (surprisingly strong):** historical median for that exact address, falling back to address-type median, falling back to tenant median. **Implement this in MVP** — it is a SQL query, not machine learning, and it captures most of the available value.
- **Model (V2):** LightGBM on address type, historical stats, package count/size, COD flag, time of day, driver, building metadata.
- **Feeds:** route optimization (as the per-stop `service` parameter) and ETA prediction.
- **Success:** MAE <90 s, versus ~4 min for a fixed constant.

---

## 5. Delivery Delay & Failure Risk

Predicts, **at dispatch time and continuously thereafter**, the probability a shipment misses its promise or fails entirely — enabling intervention *before* the customer is disappointed.

| Aspect | Detail |
|---|---|
| **Target** | Two binary classifiers: `P(late)` and `P(failed_attempt)` |
| **Features** | Route slack, stop position in sequence, promised-window width, address geocode confidence, historical failure rate at this address, historical failure rate for this recipient, first-attempt vs re-attempt, driver's on-time rate, weather, traffic, COD amount (high-value COD fails more — recipient must have cash), time-of-day vs recipient availability pattern |
| **Model** | LightGBM binary classification, **probability-calibrated (isotonic)** — an uncalibrated 0.8 that means 0.45 in practice makes the intervention thresholds meaningless |
| **Baseline** | Rule: `late if predicted_arrival > promised_to` — surprisingly hard to beat and must be measured against |
| **Actions** | Risk >0.7 → dispatcher alert with the top-3 contributing factors and suggested action (reroute / reassign / notify customer / offer reschedule). Risk >0.5 on a COD shipment → proactive SMS asking the recipient to confirm availability and cash |
| **Success** | Precision@top-10 % >0.6; a measured reduction in failed first attempts of ≥15 % vs the pre-model period |

**Interpretability is a hard requirement, not a nicety.** A dispatcher will not act on "risk 0.82." They act on "risk 0.82 — gated address, 2 previous failures, driver running 25 min late, narrow window." SHAP values are surfaced in the UI, and this is what makes the feature actually get used.

---

## 6. Fraud & Anomaly Detection

Highest direct financial ROI in COD-heavy markets. **Rules first, ML second** — the rules catch the obvious majority immediately and generate the labelled data the models need.

### 6.1 Rule layer (MVP — no ML required)

| Signal | Rule |
|---|---|
| POD location mismatch | POD captured >150 m from the destination geocode |
| Impossible delivery speed | Two deliveries at locations that cannot be traversed in the elapsed time |
| Mock-location provider | Android mock-location flag set, or an iOS jailbreak indicator |
| GPS teleportation | Position jump implying >200 km/h |
| No-attempt failure | `failed: customer_unavailable` with **no GPS trace within 200 m of the address** — the highest-value single rule in the entire fraud suite |
| COD variance | Remitted total ≠ collected total at hub handover |
| Cash-holding duration | Driver holding COD cash beyond the tenant's remittance SLA |
| Rapid-fire completions | >N stops marked complete within M minutes |
| Off-shift activity | Any shipment event outside an active shift |

### 6.2 ML layer (V2)

| Model | Approach | Notes |
|---|---|---|
| Driver behaviour anomaly | Isolation Forest / autoencoder reconstruction error on per-driver daily behaviour vectors | **Unsupervised** — fraud labels are scarce and biased toward what the rules already catch |
| COD discrepancy risk | LightGBM on driver history, amount, route, timing, past variances | Supervised once ~6 months of reconciliation data exists |
| Collusive return rings | Graph analysis over driver × merchant × recipient with abnormal return rates | Catches organised fraud that per-entity models miss entirely |

### 6.3 Operating discipline

- **Score, do not block.** Fraud models produce a review queue for human investigators; they never automatically suspend a driver. A false positive that costs someone their income is a serious harm, and these models will have false positives.
- **Every alert carries its evidence** — the specific rule or the top contributing features, plus the raw data (GPS trace, POD photo, timeline).
- **Feedback loop:** investigator outcomes (confirmed / dismissed) become training labels. This is the only way the model improves, and it must be built into the review UI from the start.
- **Systematic bias review** before any model influences driver-facing consequences (see §8).

---

## 7. Demand Forecasting & Smart Dispatch

### 7.1 Demand forecasting (V3)

- **Target:** shipment volume per `(tenant, hub, hour)` for the next 1–14 days.
- **Approach:** start with **seasonal-naive** (same hour, same weekday, last week) — a strong baseline that many production forecasting systems never beat. Then gradient boosting with calendar features, holiday flags, promotion/campaign calendars, weather, and trend; consider Prophet or a statistical seasonal model for interpretability.
- **Requires a full year of data** for real seasonality. Ramadan, Black Friday, Christmas, and local holidays dominate variance in this domain, and a model trained on 4 months will confidently mispredict all of them.
- **Uses:** driver shift planning, vehicle allocation, hub staffing, capacity-based order acceptance.

### 7.2 Smart dispatch (V3)

The assignment scoring function in [Blueprint §8.4](./architecture-blueprint.md#84-driver-assignment-algorithm) starts with hand-tuned per-tenant weights. At V3, **learn the weights** from historical outcomes.

- **Approach:** learning-to-rank over historical assignments, targeting a composite outcome (on-time completion, cost, driver acceptance, customer rating). Offline policy evaluation *before* any live rollout.
- **Not reinforcement learning.** Online RL on live dispatch is a research project with a direct path to real-world harm (bad assignments = missed deliveries, unpaid drivers). Batch learning with offline evaluation and careful A/B rollout is the responsible approach.
- **Mandatory:** shadow-mode operation (model scores logged, human/heuristic decisions executed) for a full month before any live traffic, then a gradual tenant-by-tenant A/B rollout with a kill switch.

---

## 8. Driver Performance Analytics — Ethical Constraints

This feature carries the platform's highest ethical risk, and the design reflects that deliberately.

**What we build:** descriptive analytics — on-time rate, stops per hour, distance per stop, POD compliance, customer ratings, safety events — normalised for **route difficulty**, because comparing a dense-urban driver to a rural driver on raw stops-per-hour is simply measuring geography, not performance.

**What we deliberately do not build:**
- Automated disciplinary action or termination recommendations.
- Opaque composite "driver scores" that determine pay or work allocation without explanation.
- Continuous off-shift monitoring of any kind.

**Constraints enforced in the design:**
1. Every metric is **explainable and drillable to the underlying events**. A driver can see exactly which deliveries produced their number.
2. **Difficulty normalisation is mandatory** before any cross-driver comparison is displayed.
3. Drivers have **access to their own metrics** and a documented dispute path.
4. Location data is collected **only during an active shift** — enforced client-side *and* rejected server-side.
5. Any model influencing pay or work allocation requires documented bias review across protected characteristics before deployment.

**Rationale beyond ethics:** in the EU, algorithmic management of workers carries specific transparency obligations under GDPR Article 22 and platform-work regulation. Designing for explainability now is far cheaper than retrofitting it under regulatory pressure — and it is the right thing to do regardless.

---

## 9. Where LLMs Are Actually Used

Three narrow, bounded applications. Each has a deterministic fallback and none is on a critical path.

| Application | Why an LLM is genuinely the right tool | Guardrails |
|---|---|---|
| **Address parsing & normalisation** | Free-text addresses in mixed scripts, informal formats, and landmark-based directions ("behind the blue mosque, 3rd door") defeat regex and commercial geocoders in exactly the markets where COD matters most | Output is **structured and schema-validated**; low confidence routes to human review; results cached by input hash; never auto-applied to a high-value shipment without confirmation |
| **Delivery exception triage & summarisation** | Turning a messy timeline (GPS trace + driver notes + customer messages + failure codes) into a 2-line summary for a dispatcher handling 40 exceptions per hour is a real time-saver | Read-only, advisory, always shown alongside the raw timeline; never takes an action |
| **Support-agent assist** | Drafting customer replies grounded in actual shipment state | Human-in-the-loop; agent must approve before sending; grounded strictly in retrieved shipment data with no free generation of facts |

**Cost and privacy discipline:** LLM calls are cached, rate-limited, and budgeted per tenant. Customer PII is **never** sent to a third-party LLM without an explicit DPA covering it and tenant consent — for EU tenants this may mean a self-hosted model or no feature at all, and "no feature" is an acceptable outcome.

---

## 10. Data & Feature Platform

**Deliberately simple, and staged.** A feature store is infrastructure that many teams adopt long before they need it.

| Phase | Approach |
|---|---|
| **MVP** | No ML infrastructure. **The deliverable is correct instrumentation**: capture `occurred_at` vs `recorded_at`, plan-vs-actual on every route and stop, structured failure reason codes, geocode confidence, and POD location. Without these, V2 models are untrainable |
| **V2** | Features computed by **SQL over PostgreSQL read replicas and TimescaleDB continuous aggregates**, materialised into a `ml_features` table. Training reads from it; serving reads a Valkey-cached subset. This is sufficient to well past Tier 2 and costs one table plus scheduled jobs |
| **V3** | Adopt a feature store (Feast or equivalent) **only if** train/serve skew becomes a measured, recurring problem, or feature reuse across ≥5 models justifies the abstraction |

### Training-data integrity — the things that silently destroy models

1. **Point-in-time correctness.** A feature must reflect only what was knowable at prediction time. Computing "driver's on-time rate" over a window that includes the delivery being predicted is target leakage — it produces spectacular offline metrics and a useless production model. **This is the #1 cause of failed ML projects in operations.**
2. **Time-based splits only.** Never random k-fold on temporal operational data.
3. **Label the outcome, not the process.** `was_on_time` is derived from `occurred_at` vs `promised_to` — not from whatever a status field happened to say.
4. **Handle the survivorship problem.** Cancelled and never-attempted shipments must be explicitly included or excluded with a documented rationale, not silently dropped by a join.
5. **Version datasets.** Every trained model records the exact dataset snapshot, feature set, and code commit that produced it.

---

## 11. MLOps

| Concern | Approach |
|---|---|
| Experiment tracking | MLflow — parameters, metrics, artifacts, dataset version, per run |
| Model registry | MLflow registry with `staging` / `production` stages and explicit promotion |
| Training compute | Scheduled batch jobs on separate, larger instances. **Never on inference nodes** |
| Serving | FastAPI + gRPC in `ml-service`; models loaded at startup; blue/green model swap without a restart |
| Rollout | **Shadow mode → canary (1 tenant) → gradual rollout**, with a kill switch at every stage. A model is never released to all tenants at once |
| Monitoring | Prediction distribution drift, feature drift (PSI), online metric vs offline expectation, latency, fallback-invocation rate |
| Auto-rollback | Degradation past a threshold for N consecutive periods → automatic fallback to the previous model or to the heuristic baseline, with an alert |
| Retraining | Scheduled (nightly/weekly) **plus** drift-triggered. Every retrain is validated against the incumbent before promotion — a newer model is not automatically a better one |
| Reproducibility | Dataset snapshot + code commit + hyperparameters + random seed recorded per model version |

---

## 12. Cold Start

New tenants and new platforms have no history. This must be designed for, not discovered.

| Situation | Strategy |
|---|---|
| Brand-new platform (MVP) | Heuristics only. OSRM ETA + fixed service time + rule-based fraud. Ship it, collect clean data |
| New tenant on a mature platform | Pooled global model with `tenant_id` as a categorical feature; blend toward a tenant-specific model as volume accumulates (weight by `n/(n+k)`) |
| New driver | Fleet-average driver features until ~50 completed deliveries |
| New address | Address-type median service time; geocode confidence drives the uncertainty band |
| New geographic zone | Nearest-similar-zone statistics by density class |

**Explicit graduation thresholds** (tenant-specific ETA model at 20k deliveries; driver-specific features at 50 deliveries) prevent overfitting to tiny samples — the failure mode where a model confidently generalises from 12 data points.

---

## 13. Success Metrics — Platform Level

The measures that determine whether the AI investment was worth making:

| Metric | Target improvement vs pre-ML baseline |
|---|---|
| ETA mean absolute error | −40 % |
| Deliveries within promised window | +20 pp |
| "Where is my order?" support contacts | −30 % |
| Failed first-delivery attempts | −15 % |
| COD variance / cash shrinkage | −50 % |
| Stops per driver per hour | +8 % |
| Dispatcher time spent on exceptions | −25 % |

Each is measured against a **pre-model baseline period** and, where feasible, a **held-out control group** of tenants. Without a control, seasonal and operational changes will be misattributed to the model — in both directions.

---

## 14. Open Items

| # | Item | Blocked on |
|---|---|---|
| AI1 | Confirm access to a pilot customer's historical delivery data — without it, V2 ML slips by ~6 months | Blueprint Q6 |
| AI2 | Determine whether EU tenants permit third-party LLM processing of address data, or whether self-hosting is required | Legal/privacy review |
| AI3 | Confirm whether driver performance metrics will influence pay or work allocation — if yes, bias review and GDPR Art. 22 obligations apply and must be scoped | Business + legal input |
| AI4 | Decide the weather data provider and confirm licensing permits use as a model feature | Procurement |
