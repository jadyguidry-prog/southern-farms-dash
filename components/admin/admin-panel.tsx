'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { ADMIN_TABLES } from '@/lib/admin-config'
import { TableManager } from './table-manager'

export function AdminPanel({
  data,
}: {
  data: Record<string, Record<string, unknown>[]>
}) {
  const [active, setActive] = useState(ADMIN_TABLES[0].key)
  const activeDef = ADMIN_TABLES.find((t) => t.key === active) ?? ADMIN_TABLES[0]

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Category list */}
      <nav
        aria-label="Data categories"
        className="flex gap-2 overflow-x-auto lg:w-56 lg:shrink-0 lg:flex-col lg:overflow-visible"
      >
        {ADMIN_TABLES.map((t) => {
          const count = data[t.key]?.length ?? 0
          const isActive = t.key === active
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={cn(
                'flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors lg:w-full',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground',
              )}
            >
              <span>{t.label}</span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-xs tabular-nums',
                  isActive ? 'bg-primary-foreground/20' : 'bg-muted',
                )}
              >
                {count}
              </span>
            </button>
          )
        })}
      </nav>

      {/* Active table manager */}
      <div className="min-w-0 flex-1">
        <TableManager def={activeDef} rows={data[activeDef.key] ?? []} />
      </div>
    </div>
  )
}
