import { PageHeader } from '@/components/page-header'
import { AdminPanel } from '@/components/admin/admin-panel'
import { createClient } from '@/lib/supabase/server'
import { ADMIN_TABLES } from '@/lib/admin-config'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const supabase = await createClient()

  const results = await Promise.all(
    ADMIN_TABLES.map(async (def) => {
      let query = supabase.from(def.table).select('*')
      if (def.orderBy) {
        query = query.order(def.orderBy.column, { ascending: def.orderBy.ascending ?? true })
      }
      const { data } = await query
      return [def.key, data ?? []] as const
    }),
  )

  const data = Object.fromEntries(results) as Record<string, Record<string, unknown>[]>

  return (
    <div>
      <PageHeader
        title="Admin — Data Management"
        description="Add, import, and manage the financial records that power your dashboard. Changes appear across all pages immediately."
      />
      <AdminPanel data={data} />
    </div>
  )
}
