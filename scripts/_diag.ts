import { assembleCapacity, buildWeeklyFlows, type LedgerRow } from '../lib/spending-capacity-service'
const TODAY='2026-08-03', CHECKING='Checking 2268'
const rows: LedgerRow[]=[]
const start=new Date(Date.UTC(2025,7,4))
for(let w=0;w<51;w++)for(let d=0;d<5;d++){const dt=new Date(start);dt.setUTCDate(start.getUTCDate()+w*7+d);const date=dt.toISOString().slice(0,10);if(date>=TODAY)continue
rows.push({date,description:`SQ${date.replace(/-/g,'').slice(2)}`,amount:2600,type:'income',accountName:CHECKING})
rows.push({date,description:'Supplier invoice',amount:1500,type:'expense',accountName:CHECKING})}
for(const m of ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'])
rows.push({date:`${m}-19`,description:'AMEX EPAYMENT ACH PMT',amount:8000,type:'expense',accountName:CHECKING})
const wIn = buildWeeklyFlows(rows,{operatingAccounts:[CHECKING],today:TODAY})
const wEx = buildWeeklyFlows(rows,{operatingAccounts:[CHECKING],today:TODAY,excludeMatchers:['AMEX EPAYMENT']})
const outs=(a:any[])=>a.map(x=>x.outflow).sort((p,q)=>p-q)
console.log('weeks:',wIn.length)
console.log('distinct outflows WITH payoffs:', [...new Set(outs(wIn))].join(', '))
console.log('distinct outflows EXCLUDED   :', [...new Set(outs(wEx))].join(', '))
console.log('weeks containing a payoff:', wIn.filter(x=>x.outflow>7500).length)
