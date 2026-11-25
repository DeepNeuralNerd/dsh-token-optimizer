# dsh-token-optimizer

> **v3.0.0 changelog (2026-10-29)**: rewrote MCP tool discovery/lazy loading (search by name and description, pagination, real visibility confirmation, reconnect recovery); paused cache and fileDiff for lack of reliable invalidation proof; added "Token Optimization & Compaction" to General settings (legacy driver/layered/off, thresholds, status log); added the runtime original-text archive and the `conversation_archive` lookup tool; fixed scoped reads for preset-level summarization/cleanup services. **Read "Upgrading to 3.0" below before upgrading.**
>
> v2.2: layered compaction orchestration layeredCompact (L0 observation / L1 cleanup of historical tool results / L2 model summarization, off by default), `/token-status`, outputLadder baseline rebuild, per-session bucketed statistics.

> DeepSeek Harness layered token-optimization pipeline.**A true increment beyond what DSH already ships**: 
> it compresses/trims/samples the text entering the model to lower context cost; summarization and sampling can lose detail, so task quality and real cost must be verified separately.

Built on the real DSH plugin API (`agent/pre-step`, `tools/execute`, `tools/post-execute`, `agent/status`, etc.),
unrelated to the fictional events (such as `message:before` / `context:building`) in community design documents.

## What it does (30-second version)

| Module | Hook | Role |
| :--- | :--- | :--- |
| text2img | `agent/pre-step` | Long text (≥1000 characters) → **popup prompt** (convert to image summary / read the original as-is; the recommended option and timeout default depend on the content type) → render to an image → vision reads the image → the summary replaces the text in context. Dynamic resolution tiers (800×450 / 1440×810 / 1920×1080), the summary disk cache costs 0 API calls across sessions. A single sample once saved ~72%; the real value is **the longer the session, the more it saves** (later turns no longer carry the original) |
| outputLadder | `tools/post-execute` | **Single-pass routing** at the birthplace of tool output: error results → 300-character summary; JSON arrays/CSV (≥10k characters) → structure-aware compression; shell output (≥8k characters) → head/tail + equidistant sampling; ≥50k bytes handed to core spill; read tools exempt. Originals are saved to disk; reversible |
| cache (paused) | `tools/execute` | off by default; glob/grep always re-execute and never reuse possibly stale results |
| fileDiff (paused) | `tools/post-execute` | currently always keeps the original; no diff is generated when it cannot be confirmed that the model request still holds the baseline |
| toolTrim | `agent/created` | Tool visibility management: static trimming + **MCP lazy loading** — schemas of unused `mcp__*` tools **never enter the native tool-definition list**; the catalog searches by name/description with pagination and confirms real visibility after loading |
| compactionDriver / layeredCompact | `agent/status` | mutually exclusive scheduling of core compaction via the legacy driver or the layered controller; thresholds are configurable, and attempts, successes, and skip reasons are accurately distinguished |
| monitor | `session/disposed` | end-of-session savings statistics + **real usage aggregation and cache hit rate** (long sessions routinely 97%–99.3%) |
## Boundary with the DSH core

DSH already ships built-in `token-meter`, `compaction-basic`, `tool-result-pruner`, `spill`, `llm-retry`, `repeat-tool-reminder`——
**this plugin never re-implements them**; it only adds the increments beyond those built-ins listed above.

## Installation

```bash
dsh plugin --profile web add @zoria-lind/dsh-token-optimizer
```

A local development directory can also be mounted directly:`dsh plugin --profile web add ./dsh-token-optimizer`.

Uninstall:

```bash
dsh plugin --profile web remove @zoria-lind/dsh-token-optimizer
```

## Upgrading to 3.0

This is a major-version upgrade with breaking configuration semantics. Before upgrading, check the profile `cordis.patch.yml`: 

- **The meaning of `toolTrim.allow: []` is inverted**: in 2.x an empty array meant "no restrictions"; from 3.0 it means "forbid all trimmable inherited tools" (matching the kernel `restrict` empty-allow semantics). For "no restrictions", delete the key or write `allow: null`.
- **The outdated built-in tool allowlist was removed**: the bundle no longer hard-codes old tool names. Long allowlists you configured yourself still take effect but hide new tools outside the list; manual review is recommended.
- **cache / fileDiff are disabled by default**: both lack reliable invalidation/baseline proofs, so 3.0 no longer reuses cached results or sends only diff fragments of originals — even with `enabled: true` in old config, results just pass through. Related parameters are kept only for configuration compatibility.
- Added the "Token Optimization & Compaction" general settings and the runtime original-text archive; by default neither changes your existing compaction strategy.

## Tool discovery and MCP lazy loading

The tool catalog is no longer stuffed into the tool description and truncated. A fixed set of discovery tools supports name/description search and pagination; hidden tools remain searchable by description and reachable at the end of the catalog. Discovery tools are registered and confirmed visible in the current scope before MCP tools are hidden; on registration failure, missing interfaces, or name conflicts the original visibility is kept. The behaviors below were checked against the DSH 0.2.1-rc.2 tools service source; real API token savings must be measured by you.

- Explicit allow/deny and parent-scope restrictions remain in force; tools with the same name registered by others are not taken over. A later tools/change may retry.
- After loading, the real view of the current scope is checked; failures, user restrictions, or parent-scope interception return a reason and are not counted as success. Repeated loading does not double-count; reconnecting a same-named server refreshes the catalog, and disconnecting the last MCP does not revoke static restrictions.
- cache and fileDiff are paused and off by default; old configs pass through even with enabled:true. glob/grep re-execute every time; fileDiff preserves full text, non-text content, and additionalContexts from the inner decision, and no longer writes its old-original directory or records false savings. 3.0 has neither established reliable file invalidation nor proved that a full-file baseline is still present in the current model request; listening to compaction events alone cannot substitute for that proof.
- The bundle removes the old built-in tool allowlist so new tools do not disappear because the list went stale. Explicit user policies are preserved; permissions are never auto-expanded.

Configuration migration:

- toolTrim.allow omitted or null: no static allowlist is set; built-in tools added in the future stay visible.
- toolTrim.allow: []: forbid all trimmable inherited tools. A non-empty allow permits only the exact listed names; deny takes priority. After unknown/disconnected allowlist names are pruned, an empty list does not become "unrestricted".
- Older versions treated allow: [] as "unrestricted"; from 3.0 you must omit allow or set it to null. Long allowlists generated by old bundles also need manual review; keeping one continues to forbid MCP tools outside the list, and the loader cannot widen it.
- The core exempts scope-self-registered tools from restrict; this plugin's discovery tools are such tools. Explicitly denying the discovery tool name disables lazy loading in that scope. Parent-layer restrictions also apply to inherited capabilities; sub-agents cannot use this loader to exceed their parent's permissions. If a parent allowlist needs sub-agents to use an inherited discovery tool, it should include that name too.
- The old parameters of cache.ttl and fileDiff are kept for configuration compatibility but currently have no effect. Whether to restore them will be reviewed separately after reliable invalidation and current-request baseline proofs exist.

Examples of the model calling the discovery tool (all mcp_load_tools):

~~~json
{"query":"database","offset":0,"limit":10}
{"offset":10,"limit":10}
{"names":["mcp__server__exact_tool_name"]}
~~~

query defaults to an empty string and supports case-insensitive substring matching over names and full cached descriptions, using at most the first 200 characters; offset defaults to 0; limit defaults to 10, capped at 20; names processes at most the first 20 per call and reports how many were ignored. Results contain matched/nextOffset/items; tools still restricted after loading are listed under failed. The load counter increases only when visibility is successfully confirmed. The catalog uses definitions from the global public view as metadata supplement; actual loading is always validated against the agent's view and filter permissions.

Verification commands:

~~~powershell
node test/smoke.mjs
node test/modules.test.js
node test/availability.mjs
~~~

smoke already includes the availability cases; before the 3.0 release, smoke passed 245 checks, modules 4, and the archive suite 19. Tests cover a 1000-tool catalog, parent/child scopes, failure recovery, disconnect/reconnect, immediate disposal, real file additions/changes, and original-text preservation across cwd/session/context resets. Definition size is just the JSON byte count of test fixtures; it cannot be converted into real API token savings or desktop-experience conclusions.

## Compaction settings and status

Added "Token Optimization & Compaction" to General settings: choose the legacy driver, layered, or off for plugin auto-compaction; the tool-history cleanup and model summarization thresholds support percentage input and sliders, while the observe line and the legacy-driver threshold live in Advanced settings. The current default remains legacy driver on, layered off; strategies are not auto-migrated.

Layered defaults: 40% observation only, 50% cleanup of historical tool results; model summarization is attempted only when a re-measure after cleanup still reaches 65%. Cleanup masks some historical tool results; summarization can lose task details. "Retrievable" does not guarantee a lossless summary. The legacy driver defaults to 45% and is further limited by at least 6 turns, 100000 estimated tokens, and similar conditions.

On save, both the client and the backend validate `0 < observe line ≤ cleanup line < summary line < 100%`; the legacy-driver threshold must also lie between 0% and 100%. Both switches and thresholds are submitted in one save; the next idle check after saving reads the new config, while operations already in flight use the original config snapshot. Switching controllers preserves each side's success quota and statistics; the two never compact the same agent concurrently. Turning off plugin auto-compaction does not turn off the host's own safety compaction.

Running `/token-status` in the current conversation shows the effective controller, thresholds, estimated pressure, window source, and the plugin's last six check/cleanup/summary records for the current agent. Records distinguish attempts, successes, no safe effective segments, busy, timeouts, and failures, with timestamps, before/after estimates, duration, and whether the model call was confirmed. Empty results are not recorded as success and do not consume the success quota; an invalid summary over the same history gets a short backoff. After the kernel reports busy, the layered controller keeps the original policy of stopping automatic summarization for the session.

The window comes from the latest valid `request/context` declaration; when missing, the configured fallback is used and marked uncertain — it is not a measured model capacity. A drop in the estimated context size is not a net billing saving, and summary cost is not extrapolated when the host does not provide per-call summary usage. Compactions initiated by the kernel (automatic/manual) or by other plugins are not counted in this plugin's records.

The settings depend on host React, slots, configForms, and a resolvable `@deepseek-ai/schemastery`. Host modules are reused with no new dependencies; a schema parse failure does not block the plugin. When the settings are not served, not ready, or read-only, the page shows a default-reference/non-editable notice, and status remains checkable via commands.

Settings projection, volatile config, and UI logic are covered by automated tests; real desktop panel display and saving still require on-device confirmation. 3.0 did not adjust the host's summary preservation scope and has not proven that model summarization retains all user wording and constraints.

Tests: `node test/smoke.mjs` includes compaction and UI logic regressions; `node test/compression.mjs` can also run standalone. The settings-projection/volatile contract checks need `DSH_OPTIMIZER_HOST_FIXTURE` pointed at an isolated host fixture directory; without it those cases are explicitly skipped.

## Runtime original-text archive

In "Token Optimization & Compaction" under General settings, the "runtime original-text archive" takes an absolute directory — check it and save separately; off by default with no default write path. An editable path with front- and back-end validation is provided. Switching directories does not move old files; the previous directory is automatically kept as a lookup source. The switch does not affect the host's native session logs, and turning it off or uninstalling does not delete the archive.

Raw user messages are captured first at `agent/pre-step`, waiting for the JSONL write and `fsync` to succeed before any rewriting such as text summarization and context acceptance. Model output is generated first, then stream chunks, the final message, or the interrupted/failed terminal state are saved; ordinary requests and default summary requests wait for archiving via `llm/stream` and `session/flush`. Reuses DSH 0.2.1-rc.2 public interfaces and the native checkpoint policy without touching the kernel/ASAR; depending on load order, failures surface either as waiting-for-recovery or as direct request failures, neither of which silently continues calling the model. After a direct failure the request must be re-issued.

On write failure, pending content is retained and related requests are paused. Click "Retry archiving", run `/token-archive-retry` in the current session, change the save directory, or explicitly turn archiving off to continue; `/token-status` shows archive status, the confirmed event sequence number, pending write count, error code, and whether the lookup tool is available. A successful settings save or retry submission does not mean the content is on disk. Cancelling a wait returns this batch's not-yet-accepted inputs to the pending queue without auto-re-execution; failure buffers held only in memory cannot survive a forced exit, and events the native layer still has can be backfilled after restart.

Each session deduplicates via a stable key; each process/plugin lifecycle writes its own exclusive segment; the in-memory index is rebuilt from the JSONL in the current and historical directories. The archive cursor advances only after a confirmed disk write; a partial write failure attempts to truncate back to the batch start, and fully corrupt lines are reported without being overwritten. A newline-less tail left by a crash is repaired only when its process is confirmed exited; a possibly-still-in-use segment reports busy. Stream chunks from before enabling cannot be backfilled; historical messages are backfilled only from events the host still keeps, and summaries never masquerade as missing originals. A pre-summary checkpoint in the file marks an archive coverage check and must not be read as a compaction success record.

The model retrieves originals on demand within the current session via `conversation_archive`:

~~~json
{"action":"search","query":"deadline","limit":10}
{"action":"read","key":"the key returned by search","offset":0,"limit":2000}
{"action":"status"}
~~~

`search` returns short excerpts with keys; when `nextOffset` is non-empty, keep paging. By default it searches raw inputs, accepted inputs, and model terminal states; use `role: "assistant-stream"` for stream chunks. Each page inspects at most 2000 index entries and reads about 2MiB (allowed to finish one record up to 16MiB), with a match cap of 20. Records beyond 16MiB are explicitly listed as not full-text-searched, and a single read still returns the local file path. `read` pages by Unicode characters, default 2000, capped at 4000; the whole archive is never auto-stuffed back into context. The lookup tool is registered in the current agent's own scope, and inherited-tool trimming and MCP lazy loading will not hide it.

The archive's dedicated verification directly extracts the Inbox, preStep, flush, checkpoint policy, LLM dispatch, and compaction-transaction methods from the installed package, using fictional data for real file writes, syncs, and fault injection; context assembly, projection, the session validator, and model providers are fixtures. It is not equivalent to full desktop acceptance testing, power-loss experiments, real model task quality, or net token savings. Third parties bypassing the sessionId-carrying stream entry points are outside the current guarantees; being able to retrieve originals does not guarantee the model proactively recovers every detail.

`test/archive.mjs` depends on host fixtures extracted locally (not installed via npm, hence not in the published package) and needs `DSH_TO03_STATE` pointed at an isolated state directory.

## Configuration

Below are the plugin code defaults; the bundle install template enables toolTrim. After mounting, override them in the profile's `cordis.patch.yml` (example, all default values):

```yaml
- id: token-optimizer
 name: '@zoria-lind/dsh-token-optimizer'
 config:
  archive:
   enabled: false
   directory: ''      # fill an absolute path in General settings before enabling
   previousDirectories: []  # old directories are kept automatically when the UI changes the path
   retryGeneration: 0
  text2img:
   enabled: true
   threshold: 1000
   askOnSkip: true    # false = no popup, fall back to automatic behavior (natural language auto-converts / strongly structural content auto-skips)
   askTimeoutMs: 120000  # prompt timeout; on expiry the content-type default executes
   maxAsksPerSession: 0  # per-session popup cap (0 = unlimited); set 3~5 if popups feel too frequent; over the cap the content-type default runs silently
   summaryCache: true   # content hash -> on-disk summary cache, cross-session hits cost 0 API (includes original-save deduplication)
   dynamicResolution: true
   resolutionTiers:    # tiers by character count (sizes calibrated in practice: YaHei line height ~= 1.9x font size,
               # keeping density within the verified-safe ~1000 characters/page)
    - { maxChars: 2000, width: 800, height: 450, fontSize: 24 }
    - { maxChars: 6000, width: 1440, height: 810, fontSize: 24 }
    - { maxChars: Infinity, width: 1920, height: 1080, fontSize: 36 }
   renderWidth: 1200   # fixed width when dynamicResolution=false
   pageFontSize: 24    # used when dynamicResolution=false
   pageMaxHeight: 3000  # used when dynamicResolution=false
   visionModel: 'deepseek-v4-flash-vision-exp'
   baseUrl: 'https://api.deepseek.com/v1'
   maxSummaryChars: 2000
   maxSummaryRatio: 0.4  # summary cap = min(maxSummaryChars, input chars x 0.4), guaranteeing the replacement is shorter than the original
   pagesPerBatch: 4    # batched summarization: at most 4 pages per vision batch (prevents "reading only the first pages"), then merged as plain text
   saveOriginal: true
  outputLadder:
   enabled: true
   structureThreshold: 10000
   compressionRate: 0.5
   preserveHeadTail: 1000
   shellTools: ['pwsh', 'bash', 'sh', 'powershell', 'zsh', 'cmd']
   shellThreshold: 8000
   headLines: 10
   tailLines: 10
   sampleInterval: 20
   errorSummaryChars: 300
   spillBytes: 50000
   readTools: ['read', 'read_image']
   saveOriginal: true
  cache:
   enabled: false     # paused: no reliable file-invalidation mechanism; old true also passes through
   ttl: 3600
  fileDiff:
   enabled: false     # paused: cannot prove the current request still holds a complete baseline
   tools: ['read']
   minSize: 2048
   maxFileBytes: 200000
   contextLines: 3
   collapseUnchanged: true
  toolTrim:
   enabled: false     # off by default; when on, applies to every agent scope
   allow: null       # omitted/null = unrestricted; [] = forbid all inherited tools
   deny: []
   mcpLazy: true
   mcpPrefix: 'mcp__'
   mcpLoadToolName: 'mcp_load_tools'
  compactionDriver:
   enabled: true
   pressureRatio: 0.45   # triggers only when totalTokens / contextWindow exceeds this ratio
   minTurns: 6
   minTokens: 100000
   maxCompactionsPerSession: 3
   contextWindow: 1000000
   timeoutMs: 120000
  memory_bridge:      # placeholder section for dsh-memory-bridge integration (flip the switch after phase 3b lands)
   enabled: false
   sync_dir: '~/.dsh-memory'
   compress_on_sync: true
   compression_strategy: 'time_decay'
   text2img_threshold: 1000
   dynamic_resolution: true
```

> The v1 `compress` / `sample` / `pruning` / `dedup` sections are retired (merged into outputLadder); old config sections are silently ignored with a log notice and never break loading.

### Must-read for web deployments: re-enable the core compaction backend

The `dsh-web-app` bundle patch **disables** `compaction-basic` and `command-compact` by default (to pair with the /compact command),
so web deployments have **no compaction service**, the plugin's summary scheduling cannot run, and `/token-status` records the service as unavailable. Add at the top level of the profile's `cordis.patch.yml`:

```yaml
- id: compaction-basic
 disabled: false
- id: command-compact
 disabled: false
```

## Dependencies

- **text2img rendering**: Windows needs PowerShell + .NET System.Drawing (`scripts/render-text.ps1`, no third-party dependencies); non-Windows rendering degrades to saving the original only.
- **text2img summarization**: needs the `DEEPSEEK_API_KEY` environment variable (already configured by DSH).
- **mcpLazy**: needs the profile to mount `@deepseek-ai/dsh-mcp-client` with at least one MCP server configured; a no-op automatically without MCP.

## Development

```bash
node test/smoke.mjs     # single-process full self-check (no API needed), same as npm test
node test/modules.test.js
node test/text2img-e2e.mjs  # real end-to-end (needs an API key + Windows rendering)
```

## Roadmap

- Natural-language configuration tool (letting the model change config)
- Cross-platform rendering fallback for long text -> images
- Collaboration with [dsh-behavior-enhancer](https://github.com/Zoria-Lind/dsh-behavior-enhancer) (content compression x behavior management, independently installable)
- dsh-memory-bridge integration (config section reserved; flip the switch once the extension + bridge service are ready)



