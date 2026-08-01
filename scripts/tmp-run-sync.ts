import { runFullSync } from '../lib/square-sync'

async function main() {
  console.log('[sync] starting incremental sync...')
  const r = await runFullSync({})
  console.log('[sync] ok:', r.ok)
  console.log('[sync] ordersSynced:', r.ordersSynced)
  console.log('[sync] daysAffected:', r.daysAffected)
  if (r.error) console.log('[sync] error:', r.error)
  for (const o of r.outcomes) {
    console.log(
      '  -',
      o.resource,
      o.ok ? `ok (${o.recordsSynced})` : `FAILED: ${o.error}`,
    )
  }
}

main().catch((e) => {
  console.log('THREW:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
