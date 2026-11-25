# The DeepSeek Harness I waited for so long — in the end I patched its money hole myself

Repository: Zoria-Lind/dsh-token-optimizer (MIT License)

I am a devoted DeepSeek fan. I used to wire DeepSeek into Claude Code, but I always longed for a Harness of our own. The day it finally shipped, I installed it immediately — it works, but it left me underwhelmed: the same tasks came out worse than Claude Code, and the tokens spent were never fewer. Around that time a friend kept nagging me daily about "token-saving" architectures like opencode, which made it sting even more.
But instead of arguing with him, I started exploring the "Everything is a Plugin" path. I decided to write a plugin myself to patch the money hole of DSH burning too many tokens. This plugin is dsh-token-optimizer (quite a few community plugins share the name, so look for Zoria-Lind/dsh-token-optimizer).

My design mixes original ideas with borrowed ones.

The long-text-to-image idea came to me on my own. I like watching DeepSeek API updates, and when the Vision API news dropped I immediately checked the model & pricing page: one image costs only 384 tokens (it is now billed by image size — a 1920×1080 page is about 369 tokens, and the 384-token cap still applies, so it only gets cheaper).
Amazing! I itched right away. One image costs so few tokens — one of those famous weibo essays would blow past that on its own. And roughly 80% of the filler in them is something I never wanted to read anyway. So why not render very long text into an image, let a vision model read it once, replace it with a summary, and only then feed it into the context?
That is how text2img was born.

The token-saving ideas I heard from my friend's opencode anecdotes genuinely inspired me — tool-schema trimming and output compression became the DSH-adapted toolTrim module.
But the first attempt failed. tools.restrict() hides tools; calling it fired a tools/change event; I listened for that event to re-register; re-registering called restrict again… and of course something unexpected happened: it looped with itself 1.3 million times and OOM-crashed the host (exit 134). I was baffled for an evening — asking Claude Code, reading logs — before realizing that the act of changing tools triggered the very event my listener was watching, and the listener then changed tools again: it had bitten its own tail like Jörmungandr.
So I added three guards: no re-registration when nothing changed, act only on real changes, and treat duplicate registration as success. The regression test fires 20 change events with no re-registration; the loop is broken.
That was the most bewildering episode — and also an epiphany-level one. As a still-inexperienced developer, I truly learned that in event-driven side-effect handling, the scariest pattern is "triggering yourself".

Before building mcpLazy (MCP tool lazy-loading), I discussed the idea's feasibility with an AI and got rejected three times in a row — I will not say which AI. But I was too restless to sleep, got up in the middle of the night, and made it work.

Still, the point I most want to make is this: what I built is not a copy, it is an adaptation made after understanding what DSH already has and does not have.

At first I just wanted to try community plugins, and I found roughly 30% of them duplicate what DSH itself already does — and then fight the core after installation. That taught me: an idea alone is not enough; you must first understand what DSH already does and what it still should do, so effort is not wasted.

So I fixed the plugin's boundaries:
What the core already does well, I do not redo. token-meter, compaction, pruner, spill, llm-retry are built into DSH — hands off.
Only fill the gap the core leaves open. For example, DSH's built-in compaction triggers at 0.8, but in a 1M window an ordinary session never reaches 800k tokens — the core genuinely ignores that stretch, so it is my turn to cover it.
Use hooks that really exist, not imaginary ones. Across versions I replaced every "assumed-but-unverified" hook with hooks DSH actually supports.
There is also a clumsy footnote from my past. When building failure detection, I did not think the recognition logic through (the DSH core marks isError only for infrastructure errors; command-level failures were being treated as success), and after mounting and testing I discovered it never fired. Only after asking about DSH itself did I find the problem and go fix it.

The deepest lesson of all this: what makes a plugin truly valuable is not "I had a good idea", but "I understood the platform's boundaries" — what not to do, what to do, and how.

Enough of the journey; here are measured results.
For text2img, in several single-shot samples I measured, a 2,582-character long text that would take 1,530 tokens used only 430 tokens after conversion — about 72% saved; another 6,437-character text became a 724-character summary — the original was nearly nine times the summary.
But frankly my real judgment at the time was "the longer the session, the more it saves": once the original becomes an image plus a tight summary, later turns no longer carry the long text. So single-shot numbers look nice, but the real power shows in long sessions. I did not have time to run long sessions myself — I only tested single shots — and then shared the two plugins (the other one is dsh-behavior-enhancer) with friends, inviting them to observe with me how much long sessions actually save in daily use. I will keep widening the test group; when the samples are enough, I will add broader statistics. Everyone is welcome to test and give feedback.
One more thing to stress: the text2img module converts only genuine natural-language prose to images. Code, JSON, configuration files — I dare not touch them; rendering to an image and OCR-ing back really does destroy precise content. For convenience I gave users a "force convert" option (for strongly structural content), but I clearly mark it as not recommended.

I already covered toolTrim and mcpLazy; everyone knows the effects, so I will not elaborate.

The remaining modules: outputLadder merged the v1-era compress, sample, and pruning modules so tool output is routed once at its birthplace — errors keep a summary, JSON/CSV gets structure-aware compression, shell output gets sampling; a replacement happens only when it is shorter, otherwise nothing changes.
cache only caches "pure-function" tools. Write operations or time-sensitive tools (web search, sending messages, etc.) are not cached.
fileDiff feels quite intuitive: it records file hashes, so a second read immediately knows whether the file changed. Changed → send a diff; unchanged → collapse. Segmented reads are skipped to avoid false "changed" judgments.
For compactionDriver, since the DSH core sets the threshold at 0.8 — too high — I changed it to 0.45 so compaction triggers more readily in long sessions, with the originals kept in logs and replayable.
monitor is simple: it computes the real cache hit rate (cache hits / (input + cache hits)); long sessions typically sit at 97–99.3%.

In short, this plugin does one thing: save tokens for everyone.
I truly love DeepSeek, which is why I put in this effort. The code is open source (in PowerShell, `dsh plugin --profile web add ./dsh-token-optimizer` installs it; see https://github.com/Zoria-Lind/dsh-token-optimizer for details). If you find it interesting, use it; and if the official team sees this — please consider absorbing the functionality. Officially begging for a merge.
