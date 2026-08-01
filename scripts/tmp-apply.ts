import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// The two genuine, currently-uncategorized marketing charges, identified by
// exact description so this can never touch a COGS/grocery row. Mirrors the
// categorizeTransactions({ source: 'uncategorized_payee' }) action so the same
// Undo path works and the audit trail is honest.
const TARGETS = [
  { match: 'PAYPAL INST XFER VISTAPRINT', payee: 'VistaPrint (via PayPal)' },
  { match: 'TIKTOK PROMOTE CULVER CITY CA', payee: 'TikTok Promote' },
]
const CATEGORY = 'Marketing'

;(async () => {
  const ids: string[] = []
  const payees: string[] = []
  for (const t of TARGETS) {
    const { data, error } = await db
      .from('financial_transactions')
      .select('id, expense_category, review_status, description, amount')
      .eq('description', t.match)
    if (error) { console.log('LOOKUP ERR', error.message); return }
    if (!data || data.length === 0) { console.log('no rows for', t.match); continue }
    for (const r of data) {
      if ((r.expense_category ?? '').toLowerCase() === 'marketing') { console.log('already marketing:', r.id); continue }
      ids.push(r.id); payees.push(t.payee)
      console.log('will categorize:', r.description, '$' + Math.abs(Number(r.amount)).toFixed(2), 'was', r.expense_category ?? '(none)')
    }
  }
  if (ids.length === 0) { console.log('nothing to do'); return }

  const bulkActionId = randomUUID()
  const actor = 'system@southernfarms (v0 correction)'
  const { data: rows } = await db.from('financial_transactions').select('id, expense_category, review_status').in('id', ids)
  const reason = `Filed ${ids.length} uncategorized row(s) from ${[...new Set(payees)].join(', ')} as "${CATEGORY}".`
  const audit = (rows ?? []).flatMap((r) => [
    { transaction_id: r.id, field: 'expense_category', previous_value: String(r.expense_category ?? ''), new_value: CATEGORY, action: 'categorize_payee', bulk_action_id: bulkActionId, actor_email: actor, reason },
    { transaction_id: r.id, field: 'review_status', previous_value: String(r.review_status ?? ''), new_value: 'matched', action: 'categorize_payee', bulk_action_id: bulkActionId, actor_email: actor, reason: 'Marked reviewed alongside the category assignment.' },
  ])
  const { error: aErr } = await db.from('transaction_audit_log').insert(audit)
  if (aErr) { console.log('AUDIT ERR', aErr.message); return }
  const { error: uErr } = await db.from('financial_transactions').update({ expense_category: CATEGORY, review_status: 'matched' }).in('id', ids)
  if (uErr) { console.log('UPDATE ERR', uErr.message); return }
  console.log('\nDONE. categorized', ids.length, 'rows as Marketing. bulk_action_id', bulkActionId)
})()
