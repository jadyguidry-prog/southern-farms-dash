// Category taxonomy + merge-proposal logic.
//
// Deliberately DB-free and free of any server-only import so it can be used
// from client components (the review screen), server code, and unit tests
// alike. `lib/cash-flow-service.ts` re-exports the shared constants below so
// existing importers keep working unchanged.

export const UNCATEGORIZED = 'Uncategorized'

/**
 * Known groupings of values that are the same bucket spelled differently.
 *
 * This map is a SEED FOR PROPOSALS ONLY. It is never applied to reporting on
 * its own — `canonicalCategory` ignores it entirely. Each entry becomes a
 * pre-filled proposal on the review screen that the owner must approve before
 * any number changes. Every entry was taken from values actually present in the
 * owner's data, not an invented taxonomy. Ambiguous pairs are NOT here — see
 * `CATEGORY_MERGE_SUGGESTIONS`.
 */
export const CATEGORY_ALIASES: Record<string, string> = {
  // Packaging, spelled three ways across transactions and vendors.
  packaging: 'Packaging & Labels',
  'labels & packaging': 'Packaging & Labels',
  // Software.
  software: 'Software & Communications',
  // Pest control.
  'pest control': 'Facilities & Pest Control',
  // Shipping.
  shipping: 'Shipping & Postage',
  // Cost of goods, tracked as four separate product lines.
  'meat / cogs': 'COGS',
  'food / cogs': 'COGS',
  'inventory / cogs': 'COGS',
  'bakery / cogs': 'COGS',
}

/**
 * Pairs that look mergeable but mean different things depending on the owner's
 * intent. Surfaced in the UI as a question rather than merged automatically,
 * because collapsing them would change reported numbers without consent.
 */
export const CATEGORY_MERGE_SUGGESTIONS: { values: string[]; note: string }[] = [
  {
    values: ['Equipment & Supplies', 'Equipment & Technology'],
    note: 'Both cover equipment but may separate physical supplies from technology.',
  },
  {
    values: ['Operating Supplies', 'General Supplies', 'Processing Supplies'],
    note: 'Three supply buckets that may or may not be the same spend.',
  },
]

/**
 * A display-only alias map keyed by lowercased raw category label. Built at
 * runtime from the owner's *approved* merge proposals and layered on top of the
 * static seed aliases. This is how an approved merge takes effect: purely at
 * display time, without ever rewriting a stored `expense_category`.
 */
export type CategoryAliasMap = Record<string, string>

/**
 * Canonical display name for a stored category value.
 *
 * ONLY the owner's approved merges (`approvedAliases`) group anything. The seed
 * `CATEGORY_ALIASES` map is deliberately NOT consulted here: it is a source of
 * *proposals*, not a silent regrouping. Until a proposal is approved, every
 * stored label reports under its own name, so an unapproved suggestion has zero
 * effect on any total. Undoing an approval simply removes its alias, which
 * immediately restores the ungrouped view.
 */
export function canonicalCategory(
  raw: string,
  approvedAliases?: CategoryAliasMap,
): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return UNCATEGORIZED
  return approvedAliases?.[trimmed.toLowerCase()] ?? trimmed
}

/**
 * Turn the owner's approved merges into a display alias map. Each approved
 * proposal folds every `fromCategories` label into its `toCategory`.
 */
export function buildApprovedAliasMap(
  approved: { fromCategories: string[]; toCategory: string }[],
): CategoryAliasMap {
  const map: CategoryAliasMap = {}
  for (const p of approved) {
    const to = (p.toCategory ?? '').trim()
    if (!to) continue
    for (const from of p.fromCategories ?? []) {
      const key = (from ?? '').trim().toLowerCase()
      if (key) map[key] = to
    }
  }
  return map
}

/**
 * Collapse a raw category label to a comparison key so pure spelling/casing
 * variants group together: "Packaging ", "packaging", "PACKAGING" all key to
 * `packaging`. Punctuation and the `/ COGS` style suffix separators are
 * flattened to spaces so "Meat / COGS" and "Meat COGS" also align.
 */
export function normalizeCategoryKey(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type CategoryUsage = {
  /** Raw stored value exactly as written in the data. */
  value: string
  /** How many spend transactions carry this exact value. */
  count: number
  /** Absolute dollars on those transactions. */
  total: number
  /** Distinct vendors carrying this value. */
  vendorCount: number
}

export type MergeProposalKind = 'variant' | 'family' | 'ambiguous'

export type MergeProposal = {
  /** Target label everything in `fromCategories` would fold into. */
  toCategory: string
  /** Raw stored values to be merged, preserved verbatim for reversal. */
  fromCategories: string[]
  kind: MergeProposalKind
  reason: string
  transactionCount: number
  totalAmount: number
  vendorCount: number
  /**
   * Ambiguous proposals must not be pre-checked in the UI — merging them
   * changes meaning, so the owner has to opt in deliberately.
   */
  requiresChoice: boolean
}

function sumUsages(
  values: string[],
  byValue: Map<string, CategoryUsage>,
): Pick<MergeProposal, 'transactionCount' | 'totalAmount' | 'vendorCount'> {
  let transactionCount = 0
  let totalAmount = 0
  const vendors = new Set<string>()
  for (const v of values) {
    const u = byValue.get(v)
    if (!u) continue
    transactionCount += u.count
    totalAmount += u.total
    // vendorCount is a per-value count; approximate the union by summing, then
    // cap below. We cannot recover identity here, so this is an upper bound and
    // labelled as such in the UI copy.
    vendors.add(`${v}:${u.vendorCount}`)
  }
  const vendorCount = values.reduce(
    (s, v) => s + (byValue.get(v)?.vendorCount ?? 0),
    0,
  )
  return { transactionCount, totalAmount, vendorCount }
}

/**
 * Propose category merges from the values actually present in the data.
 *
 * Three kinds, in priority order so each raw value is proposed at most once:
 *  1. `family`  — matches the curated alias map (e.g. the four COGS lines).
 *  2. `variant` — same `normalizeCategoryKey` but different raw spelling/case,
 *                 not already covered by a family. These are safe: they are the
 *                 same word typed differently.
 *  3. `ambiguous` — curated suggestions whose members might be distinct spend;
 *                 flagged `requiresChoice` so the UI never pre-checks them.
 *
 * A proposal is only emitted when it would actually combine two or more stored
 * values that exist in the data — a single clean value produces nothing.
 */
export function proposeCategoryMerges(usages: CategoryUsage[]): MergeProposal[] {
  const byValue = new Map<string, CategoryUsage>()
  for (const u of usages) {
    if (!u.value?.trim()) continue
    byValue.set(u.value, u)
  }
  const present = [...byValue.keys()]
  const claimed = new Set<string>()
  const proposals: MergeProposal[] = []

  // 1. Curated families from the alias map.
  const familyTargets = new Map<string, string[]>()
  for (const value of present) {
    const target = CATEGORY_ALIASES[value.toLowerCase()]
    if (!target) continue
    const list = familyTargets.get(target) ?? []
    list.push(value)
    familyTargets.set(target, list)
  }
  for (const [target, sources] of familyTargets) {
    // Include the target itself if it is also present as a stored value, so the
    // proposal reflects the true post-merge total.
    const members = [...sources]
    if (byValue.has(target) && !members.includes(target)) members.push(target)
    if (members.length < 2 && !byValue.has(target)) {
      // Only one variant and the canonical name isn't stored separately — still
      // worth proposing the rename so the stored value matches the label.
      if (members.length === 0) continue
    }
    if (members.length < 2) continue
    for (const m of members) claimed.add(m)
    proposals.push({
      toCategory: target,
      fromCategories: members.filter((m) => m !== target).sort(),
      kind: 'family',
      reason: `Same spend recorded under ${members.length} labels.`,
      requiresChoice: false,
      ...sumUsages(members, byValue),
    })
  }

  // 2. Spelling / casing variants not already claimed by a family.
  const variantGroups = new Map<string, string[]>()
  for (const value of present) {
    if (claimed.has(value)) continue
    const key = normalizeCategoryKey(value)
    if (!key) continue
    const list = variantGroups.get(key) ?? []
    list.push(value)
    variantGroups.set(key, list)
  }
  for (const members of variantGroups.values()) {
    if (members.length < 2) continue
    for (const m of members) claimed.add(m)
    // Keep the most-used spelling as the target.
    const target = [...members].sort(
      (a, b) => (byValue.get(b)?.count ?? 0) - (byValue.get(a)?.count ?? 0),
    )[0]
    proposals.push({
      toCategory: target,
      fromCategories: members.filter((m) => m !== target).sort(),
      kind: 'variant',
      reason: 'Same category, spelled or capitalised differently.',
      requiresChoice: false,
      ...sumUsages(members, byValue),
    })
  }

  // 3. Curated ambiguous suggestions.
  for (const suggestion of CATEGORY_MERGE_SUGGESTIONS) {
    const members = suggestion.values.filter(
      (v) => byValue.has(v) && !claimed.has(v),
    )
    if (members.length < 2) continue
    for (const m of members) claimed.add(m)
    proposals.push({
      toCategory: members[0],
      fromCategories: members.slice(1).sort(),
      kind: 'ambiguous',
      reason: suggestion.note,
      requiresChoice: true,
      ...sumUsages(members, byValue),
    })
  }

  // Highest-dollar proposals first — that is where a wrong split most distorts
  // the spend chart.
  return proposals.sort((a, b) => b.totalAmount - a.totalAmount)
}
