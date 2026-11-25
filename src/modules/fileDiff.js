// Compatibility entry for retired cross-call file diffs. A remembered file
// is not proof that its complete baseline remains in the model's request.
// Session compaction events alone cannot prove all context projections.
// Keep the final downstream decision intact, including content and metadata.
export function createFileDiffModule(ctx, config, _stats) {
  if (typeof ctx?.on !== 'function') return () => {}
  if (config?.enabled) console.warn('[dsh-token-optimizer] fileDiff is paused: cannot confirm the current request still holds the full baseline; keeping the original')
  const handler = (_exec, _result, next) => next()
  ctx.on('tools/post-execute', handler)
  return () => ctx.off('tools/post-execute', handler)
}
