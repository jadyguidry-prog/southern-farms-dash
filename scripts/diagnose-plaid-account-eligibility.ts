/**
 * Read-only. Answers "why did Plaid refuse the bank but accept the card?"
 *
 * Plaid tags each account with `holder_category` (personal | business |
 * unrecognized). If the account that DID connect is tagged `business`, then the
 * "Only business accounts can be connected" pane is holder-category gating at the
 * team level, which no Link customization can change.
 *
 * Also prints the use cases actually live on the Item, which is the only way to
 * confirm from outside the dashboard what was really published.
 *
 * Usage:
 *   set -a && source .env.development.local && set +a
 *   npx tsx scripts/diagnose-plaid-account-eligibility.ts
 */
import { createClient } from "@supabase/supabase-js"
import { decryptToken } from "../lib/plaid-crypto"

const PLAID_HOST = `https://${process.env.PLAID_ENV ?? "production"}.plaid.com`

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function plaid(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${PLAID_HOST}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("PLAID_CLIENT_ID"),
      secret: requireEnv("PLAID_SECRET"),
      ...body,
    }),
  })
  return (await res.json()) as Record<string, any>
}

async function main() {
  const db = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"))

  const { data: items, error } = await db
    .from("plaid_items")
    .select("item_id,institution_name,institution_id,status,access_token_encrypted")
    .eq("status", "active")
  if (error) throw new Error(`plaid_items: ${error.message}`)
  if (!items?.length) {
    console.log("No active items. Nothing to inspect.")
    return
  }

  for (const item of items) {
    console.log(`\n=== ${item.institution_name} (${item.institution_id}) ===`)
    const accessToken = decryptToken(item.access_token_encrypted)

    const itemInfo = await plaid("/item/get", { access_token: accessToken })
    if (itemInfo.error_code) {
      console.log(`  /item/get failed: ${itemInfo.error_code} ${itemInfo.error_message}`)
    } else {
      const it = itemInfo.item ?? {}
      console.log(`  consented_products : ${JSON.stringify(it.consented_products ?? "n/a")}`)
      // The live use cases -- the only view of what the dashboard actually published.
      console.log(`  consented_use_cases: ${JSON.stringify(it.consented_use_cases ?? "n/a")}`)
    }

    const accounts = await plaid("/accounts/get", { access_token: accessToken })
    if (accounts.error_code) {
      console.log(`  /accounts/get failed: ${accounts.error_code} ${accounts.error_message}`)
      continue
    }
    for (const a of accounts.accounts ?? []) {
      console.log(
        `  ${a.name} ••${a.mask ?? "?"} | ${a.type}/${a.subtype} | holder_category=${
          a.holder_category ?? "NOT RETURNED"
        }`,
      )
    }
  }

  console.log(
    "\nIf the connected account reads holder_category=business, the block on the bank is\nteam-level holder-category gating -- a Plaid support question, not a settings toggle.",
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
