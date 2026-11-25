# dsh-token-optimizer & dsh-behavior-enhancer — Technical Decision Records

> **Design Decisions & Technical Report**
> This record walks through the key calls the two plugins got right while building on the real DSH (DeepSeek Harness)
> plugin API, in the form "problem → solution → why designed this way → measured results".
> All data comes from real-session measurements; nothing is fabricated.

---

## 0. Project background

DSH (DeepSeek Harness) is a **Cordis plugin host**; plugins attach to real events via `ctx.on(event, handler)`.
The two plugins divide the work:

| Plugin | What it manages | In one sentence |
| :--- | :--- | :--- |
| **dsh-token-optimizer** | The **content** entering the model | Compress/trim/sample/summarize to lower token cost |
| **dsh-behavior-enhancer** | **How the model calls tools** | Behavioral discipline / failure convergence / parallelism recovery for stability |

They are independent and installable separately. This document focuses on four technically deep decisions.

---

## 1. "Only the increment beyond the core" — a boundary-first architectural call

### Problem
The DSH core **already ships** `token-meter`, `compaction-basic`, `tool-result-pruner`, `spill`, and `llm-retry`.
If a plugin **re-implements** them, it reinvents the wheel, fights the core, and can even break stability.

### Solution
**Explicitly refuse to re-implement core capabilities**; cover only the ranges they **do not reach**.

| Core built-in | Plugin counterpart | The gap being filled |
| :--- | :--- | :--- |
| spill (>50k bytes) | outputLadder | **The 8k–50k character "wild zone"** (spill does not reach it; the pruner only acts when compaction triggers) |
| tool-result-pruner (8192 chars) | outputLadder sampling | Shell output head/tail + equidistant sampling, with line numbers |
| compaction basic (0.8 threshold) | compactionDriver | **The 0.8 threshold almost never fires for 1M-window models**; this module lowers it to 0.45 so compaction actually happens |
| (full MCP tool schema injection) | toolTrim / mcpLazy | **Unused MCP tool schemas never enter the request** |

### Why designed this way
The **boundaries** verified from core source are the design premise — only by separating "what the core already solves" from "what the core leaves alone" does a plugin become a **true increment**, not duplication or friction.

### Measured results
- `outputLadder`: a **single measurement** (a Sept. 1 session; eight 9k–50k character wild-zone outputs sampled) saved about **10% of total input**; the steady-state rate is still being gathered.
- `toolTrim + mcpLazy`: 24 modlens MCP tool schemas (about **9,362 tokens**) kept out of requests — a fixed 9k saving per request.
- `compactionDriver`: moved context compaction **from "theoretical" to "actually runs"** (the core 0.8 threshold never triggered even at a measured 490k tokens in a 1M window).

---

## 2. The restrict death-loop incident: triple guards born of an OOM-level accident

### Problem (a real incident)
`tools.restrict()` changes tool visibility and **fires the `tools/change` event**.
If a plugin listens to `tools/change` to re-register → re-registering calls `restrict` again → fires `tools/change` again → …
**It formed a death loop that OOM-crashed the DSH harness after 1.3 million iterations (exit 134).**

### Solution (three guards)
1. **`filterKey` idempotence**: use `JSON.stringify(filter)` as the key; no re-registration when the filter is unchanged. The filterKey is recorded only after restrict **succeeds**; failures are not recorded (so the next attempt may retry with the same filter).
2. **Toolset change detection**: `onToolsChange` re-discovers MCP tool names and **compares first** whether anything really changed; without a real change it returns immediately (breaking the "change → re-register → change" loop).
3. **Treat "already registered" as success**: if mounting reports a duplicate name (repeat events / leftover scopes), treat it as registered and stop retrying.

### Why designed this way
A classic combination of **idempotence + change detection**: **the action that responds to an event must not itself trigger the event it is responding to**.
Strict contract compliance: "register the new, then withdraw the old" (fail-closed). If registering the new one fails, the old gate stays exactly as it was — **never released early**.

### Measured results
- Regression test: 20 consecutive `tools/change` events with no real change cause **no re-registration** (the restrict count stays the same); the death loop is cut.
- The root cause was "**a side effect triggering the very event being listened for**" — an excellent engineering lesson.

---

## 3. Two-tier failure detection: understanding the tool layer vs the command layer

### Problem
DSH's `pwsh` tool marks `isError: true` **only for infrastructure errors** (spawn failures/aborts).
**Command-level failures** (non-zero exit codes / stderr errors) come back as **ordinary successful results** —
measured: `$ErrorActionPreference='Stop'; Get-Item missing` returns `isError: false` with content carrying `[stderr] ... [exit code: 1]`.

If parallel convergence only checks `result.isError`, **command-level failures count as success** and serialization never triggers — the easiest trap in testing.

### Solution (`detectFailure`)
Added **command-level failure detection** (`stderrAsFailure`, on by default):
1. **Non-zero exit codes** (the strongest signal): regex `[exit code: 1-9]`.
2. **Typical stderr error signatures**: `error|failed|exception|cannot|not found|no such file|does not exist|access denied|not found|does not exist|access denied|unable to`, while **avoiding warning-class noise**.

### Why designed this way
This is a **reverse-engineered understanding of tool-boundary semantics** — do not only check "did the tool say it failed"; also check "did the command actually fail".
The two tiers (`isError` + command-level signatures) complement each other; command-level signatures use regex rather than a structured API because DSH flattens command results into the content text.

### Measured results
- Triggered with `Get-Item missing`, `detectFailure` correctly identifies a failure → `serialize()` fires and the parallel pool cap drops to 1.
- **Honest boundary**: the regex leans on English Windows error paths; Chinese or exit-code-less server errors can be missed — a known area for future hardening.

---

## 4. Cross-process state persistence: fixing "stale parallelism never restored"

### Problem
`parallelConvergence` squeezes `maxParallelToolCalls` down to 1 on a **tool failure** and **recovers after consecutive successes**.
But if the **process is killed / the session never ends** after serialization and before recovery, a new instance starts with `serialized = false`, and
**that stale-but-real `maxParallelToolCalls = 1` is never restored** — the user's parallelism stays stuck at 1 forever.

### Solution (`state.json` persistence across boots)
1. **Persist on serialization**: `serialize()` writes `~/.dsh/behavior-enhancer/state.json` recording `{ serialized: true, originalParallel }`.
2. **Take over and restore at boot**: in the `ctx.inject(['settings'])` callback, if `stale.serialized && current value === 1`, restore to `originalParallel` and log the takeover.
3. **Clear on restore**: `restore()` calls `clearState()` to delete the file.

### Why designed this way
The classic **state-persistence problem of distributed/long-running processes**: "the process is gone, but the shared state it tampered with in memory is still there".
Persisting "the trace of an interrupted state" and actively taking over at boot guarantees that **a tampered state is always eventually restored**, never left behind forever.

### Measured results
- Crafted a `serialized: true` state file → the plugin detects and restores it at boot → the file is deleted.
- **Cross-validation**: in a test session, `state.json` went from `{"serialized":true,...}` → deleted by `clearState()` after 3 successes, proving `restore()` really runs.

---

## 5. Showing "savings × stability" as a pair

- **dsh-token-optimizer**: manages content and saves tokens directly (long-text-to-image routinely saves 60%–70%, extreme samples reach 90%+; output compression and MCP lazy loading save 9k/request; cache hit rate in long sessions is routinely 97%–99.3%, best single sample 99.75%).

> This is exactly the project's differentiation: not squeezing a single point of "savings" or "stability", but **a complementary pair of engineering solutions**.

---

## Appendix: measured data summary

| Module | Measured |
| :--- | :--- |
| text2img | Routinely saves **60%–70%** (extreme samples 90%+); fidelity check on small pages hit 4 runs in a row |
| outputLadder | About 10% saved in a single measurement (Sept. 1 session); steady state still being gathered |
| mcpLazy | 24 MCP tool schemas ≈ 9,362 tokens kept out of requests |
| Cache hit rate | Long sessions routinely **97%–99.3%** (best single sample 99.75%); small sessions ~68% |
| parallelConvergence | Failure → pool squeezed to 1; 3 consecutive successes → original value restored; cross-process persistent restore |

## Manual /compact vs the plugin's automatic layered compaction (new in v2.2)

**The three layered-compaction (layeredCompact) tiers and their losslessness** (enabled:false by default; enabling it automatically bypasses the legacy compactionDriver):

| Tier | Trigger | Real action | Losslessness |
|---|---|---|---|
| L0 observation | pressure ratio ≥ lowRatio (0.4) | bookkeeping only (shown as the "observation band" in /token-status), **does not lower pressure** | — |
| L1 lossless tier | ≥ midRatio (0.5) | `ctx.toolResultPruner.pruneSession(session)` + tokenMeter re-measure; savedTokens recorded after re-measure; zero effect honestly logged as pruneNoop | ✅ lossless (surface-level replacement; originals replayable, masked nodes already cited) |
| L2 lossy tier | ≥ highRatio (0.65) **and still over threshold after the L1 re-measure** | `compaction.compactNow` (timeout protection; bookkeeping classified by err.code; busy → back off for the session) | ❌ lossy (an LLM summary replaces history; originals only in the append-only log) |

**Calibration points**:
- This plugin's fileDiff / outputLadder are **projection-level** (replacements at tools/post-execute, affecting only future results entering the model);
  L1's pruneSession is **surface-level** (rewriting already-sent history) — which is precisely why it truly lowers current pressure.
  "Never rewrites already-sent history" holds only for the projection tiers; it is not a global truth.
- The boundary with the kernel `compaction-basic`: the kernel carries the 0.8 threshold and itself also uses the two-stage "**prune first, re-measure, then decide whether to go lossy**"
  (dsh-compaction-basic/lib/index.js:900-905); for a 1M window it almost never self-triggers.
  Moving L1's prune forward to 0.5 is exactly taking the kernel's "lossless first, then lossy" opportunity from 0.8 earlier.
- The relationship with manual `/compact`: the only mutual exclusion is the kernel compaction lock (ManualCompactionError busy) plus the L2-side
  session backoff (on busy, L2 assumes "a manual/other compaction is in progress" and stops auto-lossy compaction for the session; implemented in
  layeredCompact state.backedOff); L0/L1 are unaffected by the backoff.
- The legacy compactionDriver (0.45 threshold, lossy on hit) is automatically bypassed by src/index.js when layeredCompact is enabled.

---
*Contributor: Zoria-Lind*
