// Host React + general-settings slot; no build step or new frontend dependencies.
window.__ModuleLoader__.load({
  id: '@zoria-lind/dsh-token-optimizer',
  factory: (require) => {
    let React
    try { React = require('react') } catch { /* /token-status still works */ }
    const defaults = { mode: 'legacy', low: '40', mid: '50', high: '65', legacy: '45' }
    const style = {
      wrap: { padding: '12px 0', lineHeight: 1.65 },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginTop: '8px' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      input: { width: '76px', padding: '3px 6px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '5px' },
    }
    function values(value) {
      const c = value?.compactionDriver ?? {}
      const l = value?.layeredCompact ?? {}
      return {
        mode: l.enabled === true ? 'layered' : c.enabled === false ? 'off' : 'legacy',
        low: String((l.lowRatio ?? 0.4) * 100),
        mid: String((l.midRatio ?? 0.5) * 100),
        high: String((l.highRatio ?? 0.65) * 100),
        legacy: String((c.pressureRatio ?? 0.45) * 100),
      }
    }
    function apply(ctx) {
      if (!React || !ctx?.slots?.register) return
      let form
      try { form = ctx.configForms?.get?.('token-optimizer') } catch { /* show the non-editable notice */ }
      const el = React.createElement
      function Settings() {
        const snapshot = React.useSyncExternalStore(
          (listener) => form?.subscribe(listener) ?? (() => {}),
          () => form?.getSnapshot() ?? null,
          () => form?.getSnapshot() ?? null,
        )
        const live = snapshot?.value ? values(snapshot.value) : defaults
        const archiveLive = snapshot?.value?.archive ?? { enabled: false, directory: '', previousDirectories: [], retryGeneration: 0 }
        const archiveKey = JSON.stringify(archiveLive)
        const [archiveDraft, setArchiveDraft] = React.useState(archiveLive)
        const [archiveMessage, setArchiveMessage] = React.useState('')
        React.useEffect(() => { setArchiveDraft(archiveLive) }, [archiveKey])
        const key = JSON.stringify(live)
        const [draft, setDraft] = React.useState(live)
        const [message, setMessage] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        React.useEffect(() => { setDraft(live) }, [key])
        const ready = snapshot?.status === 'ready' && !!snapshot.value
        const writable = ready && snapshot.writable === true && !saving
        const change = (field, value) => { setDraft((d) => ({ ...d, [field]: value })); setMessage('') }
        const save = async () => {
          if (!writable || !form?.mutate) return
          const fields = ['low', 'mid', 'high', 'legacy']
          const raw = fields.map((field) => String(draft[field]).trim())
          const [low, mid, high, legacy] = raw.map(Number)
          if (raw.some((v) => v === '') || ![low, mid, high, legacy].every(Number.isFinite)
            || !(0 < low && low <= mid && mid < high && high < 100)
            || !(0 < legacy && legacy < 100)) {
            setMessage('Not saved: 0 < observe line <= cleanup line < summary line < 100% is required; the legacy threshold must also be between 0% and 100%.')
            return
          }
          setSaving(true)
          try {
            const result = await form.mutate([
              { op: 'set', path: ['layeredCompact', 'enabled'], value: draft.mode === 'layered' },
              { op: 'set', path: ['compactionDriver', 'enabled'], value: draft.mode === 'legacy' },
              { op: 'set', path: ['layeredCompact', 'lowRatio'], value: low / 100 },
              { op: 'set', path: ['layeredCompact', 'midRatio'], value: mid / 100 },
              { op: 'set', path: ['layeredCompact', 'highRatio'], value: high / 100 },
              { op: 'set', path: ['compactionDriver', 'pressureRatio'], value: legacy / 100 },
            ])
            setMessage(result === true ? 'Saved; the next compaction check uses the new config, while operations already running keep the previous one.'
              : result === false ? 'Save failed: the host rejected it or the write did not finish.' : 'Save result unconfirmed; check the effective values and retry.')
          } catch (err) { setMessage('Save failed: ' + (err?.message ?? err)) }
          finally { setSaving(false) }
        }
        const saveArchive = async (retry = false) => {
          if (!writable || !form?.mutate) return
          const directory = archiveDraft.directory.trim()
          if (!retry && archiveDraft.enabled && !(/^[A-Za-z]:[\\/]/.test(directory) || directory.startsWith('\\\\') || directory.startsWith('/'))) {
            setArchiveMessage('Not saved: enabling archiving requires an absolute directory path.'); return
          }
          setSaving(true)
          try {
            const old = archiveLive.directory
            const history = [...new Set([...(archiveLive.previousDirectories ?? []), ...(old && old !== directory ? [old] : [])])]
            const ops = retry
              ? [{ op: 'set', path: ['archive', 'retryGeneration'], value: (archiveLive.retryGeneration ?? 0) + 1 }]
              : [
                { op: 'set', path: ['archive', 'enabled'], value: !!archiveDraft.enabled },
                { op: 'set', path: ['archive', 'directory'], value: directory },
                { op: 'set', path: ['archive', 'previousDirectories'], value: history },
                { op: 'set', path: ['archive', 'retryGeneration'], value: archiveLive.retryGeneration ?? 0 },
              ]
            const result = await form.mutate(ops)
            setArchiveMessage(result === true
              ? retry ? 'Retry submitted; check /token-status for the write result.' : 'Archive settings saved; later input is checked against this config; check /token-status for write status.'
              : result === false ? 'Save failed: the host rejected it or the write did not finish.' : 'Save result unconfirmed; check the values and retry.')
          } catch (err) { setArchiveMessage('Save failed: ' + (err?.message ?? err)) }
          finally { setSaving(false) }
        }
        function threshold(field, label) {
          return el('label', { style: style.row },
            el('span', null, label),
            el('input', { type: 'range', min: 0.1, max: 99.9, step: 0.1, value: draft[field], disabled: !writable, 'aria-label': label + ' slider', onChange: (e) => change(field, e.target.value) }),
            el('input', { type: 'number', min: 0.1, max: 99.9, step: 0.1, value: draft[field], disabled: !writable, style: style.input, 'aria-label': label, onChange: (e) => change(field, e.target.value) }),
            el('span', null, '%'))
        }
        return el('section', { style: style.wrap },
          el('div', { style: { fontWeight: 600 } }, 'Token Optimization & Compaction'),
          el('div', { style: style.hint }, ready
            ? 'Current controller: ' + ({ legacy: 'Legacy driver', layered: 'Layered', off: 'Plugin auto-compaction off' }[live.mode])
            : 'Current config not yet available; the values below are non-editable defaults for reference.'),
          el('label', { style: style.row }, 'Auto-compaction strategy',
            el('select', { value: draft.mode, disabled: !writable, 'aria-label': 'Auto-compaction strategy', onChange: (e) => change('mode', e.target.value) },
              el('option', { value: 'legacy' }, 'Legacy driver (keep the existing strategy)'),
              el('option', { value: 'layered' }, 'Layered (clear tool history first, then try summarization)'),
              el('option', { value: 'off' }, 'Turn off plugin auto-compaction'))),
          threshold('mid', 'Tool-history cleanup threshold'),
          threshold('high', 'Model summarization threshold'),
          el('details', null, el('summary', null, 'Advanced thresholds'),
            threshold('low', 'Observe line (observation only, no compaction)'),
            threshold('legacy', 'Legacy driver threshold')),
          el('div', { style: style.hint }, 'Layered thresholds take effect only under the layered strategy; the legacy driver is also limited by minimum turns and token counts.'),
          el('div', { style: style.hint }, 'Current defaults are kept; layered mode is not enabled automatically. Turning auto-compaction off here still leaves the host\u2019s own safety compaction in place.'),
          el('div', { style: style.hint }, 'Tool-history cleanup shadows some past results; model summarization may lose detail. Being able to retrieve originals does not mean the summary is lossless.'),
          el('div', { style: style.hint }, 'For this session\u2019s trigger reasons, attempts/successes, before/after estimates and failure causes: use /token-status.'),
          el('button', { disabled: !writable, onClick: save }, saving ? 'Saving\u2026' : 'Save compaction settings'),
          el('div', { role: 'status', style: style.hint }, message || (ready ? snapshot.writable ? 'Edits save as one group; the next check picks them up.' : 'The current config is read-only; saving is unavailable.' : 'Settings service not ready; you can view runtime state with /token-status.')),
          el('div', { style: { fontWeight: 600, marginTop: '18px' } }, 'Runtime Original-Text Archiving'),
          el('label', { style: style.row },
            el('input', { type: 'checkbox', checked: !!archiveDraft.enabled, disabled: !writable, 'aria-label': 'Enable original-text archiving', onChange: e => setArchiveDraft(d => ({ ...d, enabled: e.target.checked })) }), 'Save user originals and model outputs (off by default)'),
          el('label', { style: style.row }, 'Archive directory',
            el('input', { type: 'text', value: archiveDraft.directory, disabled: !writable, style: { ...style.input, width: 'min(100%, 460px)' }, 'aria-label': 'Original-text archive directory', placeholder: 'Enter an absolute directory path', onChange: e => setArchiveDraft(d => ({ ...d, directory: e.target.value })) })),
          el('div', { style: style.hint }, 'User originals are released only after a successful disk write; model outputs are saved after generation and confirmed before later model calls and summarization. A failed write blocks the related request; retry, change the directory, or explicitly turn archiving off to continue.'),
          el('div', { style: style.hint }, 'Switching directories does not move old files; the old directory stays as a retrieval source. Within a session, use conversation_archive to search and read pages on demand; stream fragments lost before enabling cannot be backfilled.'),
          el('div', { style: style.hint }, 'Previous archive directories: ' + ((archiveLive.previousDirectories ?? []).join('; ') || 'none')),
          el('button', { disabled: !writable, onClick: () => saveArchive(false) }, 'Save archive settings'),
          el('button', { disabled: !writable || !archiveLive.enabled, onClick: () => saveArchive(true) }, 'Retry archiving'),
          el('div', { role: 'status', style: style.hint }, archiveMessage))
      }
      const disposers = []
      // Mount the readable row first, then subscribe to the namespace; a clear non-editable state shows even before it is served.
      const register = () => ctx.slots.register({ name: 'settings.general.item', id: 'token-optimizer.compression', order: 710 }, Settings)
      if (typeof ctx.slots.inject === 'function') disposers.push(ctx.slots.inject('settings.general.item', register))
      else disposers.push(register())
      try {
        if (ctx.configForms?.whileServed) disposers.push(ctx.configForms.whileServed(['token-optimizer'], () => () => {}))
      } catch { /* the row is still readable; the save button stays disabled */ }
      let disposed = false
      const cleanup = () => {
        if (disposed) return
        disposed = true
        for (const dispose of disposers) if (typeof dispose === 'function') dispose()
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
      return cleanup
    }
    return { inject: ['slots', 'configForms'], apply }
  },
})
