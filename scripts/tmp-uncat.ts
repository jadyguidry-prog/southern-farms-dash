import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Mirror of MARKETING_PATTERNS confident entries (kept in sync manually for this probe).
const CONFIDENT: { test: RegExp; channel: string }[] = [
  { test: /FACEBK|FACEBOOK|META\s*PLAT|METAPLAT|META ADS|INSTAGRAM/, channel: 'Facebook / Meta Ads' },
  { test: /GOOGLE\s*ADS|ADWORDS/, channel: 'Google Ads' },
  { test: /MAILCHIMP|KLAVIYO|CONSTANT CONTACT|SENDGRID/, channel: 'Email marketing' },
  { test: /TEXTEDLY|SIMPLETEXTING|ATTENTIVE/, channel: 'SMS marketing' },
  { test: /BILLBOARD|LAMAR|OUTFRONT|\bOUTD\b|\bOUTDOOR\b/, channel: 'Billboards / outdoor' },
  { test: /BROADCAS|\bRADIO\b|CABLE ADVERT/, channel: 'Radio / TV advertising' },
  { test: /\bSIGNS?\b|\bSIGNAGE\b|\bBANNER|\bPRINTING\b|VISTAPRINT|VISTA PRINT/, channel: 'Signage / printing' },
  { test: /\bYELP\b|THUMBTACK/, channel: 'Directory listings' },
  { test: /TIKTOK|TIK TOK/, channel: 'TikTok Ads' },
]
const SPEND = ['debit', 'withdrawal', 'payment', 'check', 'ach', 'purchase', 'fee', 'expense']

;(async () => {
  const { data, error } = await db
    .from('financial_transactions')
    .select('id, transaction_date, description, amount, transaction_type, expense_category, vendor_id, review_status')
    .order('transaction_date')
  if (error) { console.log('ERR', error.message); return }
  let total = 0
  const rows: any[] = []
  for (const r of data ?? []) {
    if (r.review_status === 'excluded') continue
    if (r.expense_category && r.expense_category.toLowerCase() === 'marketing') continue
    const d = String(r.description).toUpperCase()
    const hit = CONFIDENT.find((p) => p.test.test(d))
    if (!hit) continue
    total += Math.abs(Number(r.amount))
    rows.push({ id: r.id, date: r.transaction_date, desc: r.description, amt: Number(r.amount), cat: r.expense_category, channel: hit.channel })
  }
  console.log('UNCATEGORIZED-BUT-CONFIDENT MARKETING:', rows.length, 'rows, total $' + total.toFixed(2))
  for (const r of rows) console.log(' ', r.date, ('$' + Math.abs(r.amt).toFixed(2)).padStart(10), '|', r.channel.padEnd(20), '|', r.desc, '| cat:', r.cat ?? '(none)', '|', r.id)

  // TikTok specifically (not currently a confident pattern in prod)
  const { data: tk } = await db.from('financial_transactions').select('transaction_date, description, amount, expense_category').ilike('description', '%TIKTOK%')
  console.log('\nTIKTOK rows:', JSON.stringify(tk))
  // Confirm Rouse's Market would NOT be pulled in
  const { data: rouse } = await db.from('financial_transactions').select('description, amount, expense_category').ilike('description', '%ROUSE%')
  console.log('ROUSE rows (should NOT be marketing):', JSON.stringify(rouse))
})()
