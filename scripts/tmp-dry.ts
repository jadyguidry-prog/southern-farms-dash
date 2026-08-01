import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const m=(n:any)=>'$'+Number(n||0).toFixed(2)
async function page(t:string,cols:string){const out:any[]=[];for(let f=0;;f+=1000){const{data,error}=await sb.from(t).select(cols).range(f,f+999);if(error){console.log('ERR',error.message);return out}out.push(...(data??[]));if(!data||data.length<1000)break}return out}
async function main(){
  const tx=(await page('financial_transactions','id,transaction_date,description,amount,transaction_type,expense_category,review_status,deleted_at')).filter((r:any)=>!r.deleted_at)

  console.log('=== EXACT existing category strings containing "market" (rule 5: reuse vocabulary) ===')
  const cats=new Set(tx.map((r:any)=>String(r.expense_category||'').trim()).filter(Boolean))
  for(const c of [...cats].sort()) if(/market/i.test(c)) console.log('   ['+c+']')
  console.log('   total distinct categories:',cats.size)

  // The three the owner CONFIRMED. Anchored to avoid the AMAZON MARKETPLACE trap.
  const TARGETS:[string,RegExp][]=[
    ['BAYOU SIGNS OUTD', /BAYOU SIGNS/i],
    ['COASTAL BROADCASTING', /COASTAL BROADCAS/i],
    ['PAYPAL - METAPLATFOR', /METAPLATFOR/i],
  ]
  let grand=0, grandN=0
  const plan:any[]=[]
  for(const [label,re] of TARGETS){
    const hits=tx.filter((r:any)=>re.test(String(r.description||'')))
    console.log(`\n=== ${label} — ${hits.length} rows`)
    const bad=hits.filter((r:any)=>String(r.expense_category||'').trim())
    const uncat=hits.filter((r:any)=>!String(r.expense_category||'').trim())
    const nonSpend=hits.filter((r:any)=>!['expense','fee','interest'].includes(r.transaction_type))
    for(const r of hits.sort((a:any,b:any)=>a.transaction_date<b.transaction_date?-1:1))
      console.log('   ',r.transaction_date,m(Math.abs(+r.amount)).padStart(10),'type='+String(r.transaction_type).padEnd(8),'cat=['+String(r.expense_category||'')+']',String(r.description).slice(0,38))
    console.log('   -> would change:',uncat.length,'rows',m(uncat.reduce((s:number,r:any)=>s+Math.abs(+r.amount),0)))
    if(bad.length) console.log('   -> SKIP (already categorized, will not overwrite):',bad.length,bad.map((r:any)=>r.expense_category))
    if(nonSpend.length) console.log('   -> WARNING non-spend rows present:',nonSpend.length)
    grand+=uncat.reduce((s:number,r:any)=>s+Math.abs(+r.amount),0); grandN+=uncat.length
    plan.push({label,ids:uncat.map((r:any)=>r.id)})
  }
  console.log('\n=== TOTAL TO FILE:',grandN,'rows',m(grand))
  console.log('=== REV LETSREV: intentionally NOT touched (owner did not confirm) ===')
  const rev=tx.filter((r:any)=>/LETSREV/i.test(String(r.description||'')))
  console.log('   ',rev.length,'rows',m(rev.reduce((s:number,r:any)=>s+Math.abs(+r.amount),0)),'-> left uncategorized, will appear in the new queue')
}
main().catch(e=>console.log('ERR',e.message))
