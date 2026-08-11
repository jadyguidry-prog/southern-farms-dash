/**
 * Reports what Plaid actually stored after a Link connection: which items exist,
 * which accounts came back, and whether each account is mapped to a ledger account.
 *
 * Read-only. Safe to run any time.
 *   npx tsx scripts/check-plaid-connection-state.ts
 */
import { createClient } from "@supabase/supabase-js"

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing")
  const db = createClient(url, key)

  const { data: items, error: itemsError } = await db
    .from("plaid_items")
    .select("id,institution_name,institution_id,status,cursor,created_at")
    .order("created_at")
  if (itemsError) throw new Error(`plaid_items: ${itemsError.message}`)

  console.log(`=== plaid_items: ${items.length} ===`)
  for (const i of items) {
    console.log(
      `  ${i.institution_name} | ${i.institution_id} | status=${i.status} | cursor=${
        i.cursor ? "set (has synced)" : "null (never synced)"
      }`,
    )
  }

  const { data: accounts, error: accountsError } = await db
    .from("plaid_accounts")
    .select("item_id,plaid_name,mask,type,subtype,account_name,amount_convention,import_from_date,is_enabled")
    .order("created_at")
  if (accountsError) throw new Error(`plaid_accounts: ${accountsError.message}`)

  console.log(`\n=== plaid_accounts: ${accounts.length} ===`)
  for (const a of accounts) {
    console.log(`  ${a.plaid_name} | mask=${a.mask ?? "-"} | ${a.type}/${a.subtype}`)
    console.log(
      `      mapped to: ${a.account_name ?? "NOT MAPPED"} | sign=${a.amount_convention} | import_from=${
        a.import_from_date ?? "unset (would import ALL history)"
      } | enabled=${a.is_enabled}`,
    )
  }

  const unmapped = accounts.filter((a) => !a.account_name).length
  const neverSynced = items.filter((i) => !i.cursor).length
  console.log(
    `\nsummary: ${items.length} item(s), ${accounts.length} account(s), ${unmapped} unmapped, ${neverSynced} never synced`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
