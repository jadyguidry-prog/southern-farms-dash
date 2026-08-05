'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { TableCell, TableRow } from '@/components/ui/table'
import { formatCurrency, formatDayLabel } from '@/lib/data'

/**
 * Width of the horizontally-scrollable area the table sits in, but only when the table
 * is actually wider than it (i.e. on a narrow screen). Returns null otherwise.
 *
 * On a phone the table overflows, so a breakdown laid out to the full table width has
 * its amounts sitting off-screen — the reader sees vendor names with no figures unless
 * they scroll sideways. Pinning the breakdown to the visible width fixes that, but doing
 * it unconditionally would break the desktop case, where the amounts are deliberately
 * aligned under the "Out" column. Measured at runtime rather than hardcoded so it stays
 * correct at any screen size and if the card padding ever changes.
 */
function useOverflowWidth(el: HTMLElement | null) {
  const [width, setWidth] = useState<number | null>(null)

  const measure = useCallback(() => {
    const scroller = el?.closest<HTMLElement>('[class*="overflow-x-auto"]')
    if (!scroller) return setWidth(null)
    // 1px tolerance: sub-pixel layout can make these differ by a hair with no real overflow.
    setWidth(
      scroller.scrollWidth > scroller.clientWidth + 1 ? scroller.clientWidth : null,
    )
  }, [el])

  useEffect(() => {
    if (!el) return
    measure()
    const scroller = el.closest<HTMLElement>('[class*="overflow-x-auto"]')
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [el, measure])

  return width
}

/**
 * Structural prop type rather than an import of the engine's `ForecastDay`.
 * This component only needs the fields it renders, and keeping it structural means the
 * engine can grow without dragging server-only modules into the client bundle.
 */
export type DayOutflowRow = {
  date: string
  cautiousIn: number
  moneyOut: number
  cautiousBalance: number
  breachesReserve: boolean
  items: {
    label: string
    amount: number
    kind: 'dated' | 'estimate'
    dueDate: string | null
    daysOverdue: number
  }[]
}

/**
 * One day of the forecast: the summary row, plus an expandable breakdown of what makes
 * up the "Out" figure.
 *
 * This exists because the breakdown was previously only a `title` tooltip on the Out
 * cell — invisible on a touch device, which is where this dashboard is often read. It
 * also showed labels with no amounts and no indication that a day's total can include
 * bills that were due days earlier, so a backlog looked like a single big spending day.
 */
export function DayOutflowRows({ day }: { day: DayOutflowRow }) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  // State rather than useRef: a ref assignment does not re-render, so the measurement
  // would stay null forever on first paint.
  const [anchor, setAnchor] = useState<HTMLTableCellElement | null>(null)
  const visibleWidth = useOverflowWidth(anchor)

  // Only dated items are worth itemising. A day whose entire outflow is the spread
  // estimate has nothing to reveal, so it must not offer an empty expander.
  const datedItems = day.items.filter((i) => i.kind === 'dated')
  const estimate = day.items.find((i) => i.kind === 'estimate')
  const expandable = datedItems.length > 0

  const overdueTotal = datedItems
    .filter((i) => i.daysOverdue > 0)
    .reduce((s, i) => s + i.amount, 0)

  const balanceClass = day.breachesReserve ? 'text-destructive' : 'text-foreground'

  return (
    <>
      <TableRow className={day.breachesReserve ? 'bg-destructive/5' : undefined}>
        <TableCell ref={setAnchor} className="whitespace-nowrap font-medium">
          {expandable ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={detailId}
              // min-h-11 (44px) so this is a real touch target on a phone, which is where
              // this table is most often read. Negative margins keep the extra height from
              // padding out the row.
              className="-mx-1 -my-2 flex min-h-11 items-center gap-1.5 rounded px-1 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ChevronRight
                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                  open ? 'rotate-90' : ''
                }`}
                aria-hidden="true"
              />
              {formatDayLabel(day.date)}
              <span className="sr-only">
                {open ? ' — hide breakdown' : ' — show breakdown'}
              </span>
            </button>
          ) : (
            // Indented to match the expandable rows so the day column stays aligned.
            <span className="pl-[calc(0.875rem+0.375rem)]">{formatDayLabel(day.date)}</span>
          )}
        </TableCell>

        <TableCell className="text-right tabular-nums text-muted-foreground">
          {day.cautiousIn > 0 ? formatCurrency(day.cautiousIn) : '—'}
        </TableCell>

        <TableCell className="text-right tabular-nums">
          {day.moneyOut > 0 ? formatCurrency(day.moneyOut) : '—'}
          {/* Named on the row itself, not just inside the expander: a day inflated by a
              backlog should be recognisable without opening anything. */}
          {overdueTotal > 0 ? (
            <span className="block text-xs font-normal text-muted-foreground">
              incl. {formatCurrency(overdueTotal)} overdue
            </span>
          ) : null}
        </TableCell>

        <TableCell className={`text-right tabular-nums font-medium ${balanceClass}`}>
          {formatCurrency(day.cautiousBalance)}
        </TableCell>
      </TableRow>

      {expandable && open ? (
        <TableRow className="hover:bg-transparent">
          {/* Spans only the first three columns so each item's amount right-aligns under
              the "Out" heading it belongs to. Spanning all four pushed the amounts under
              "Balance", which read as running balances rather than components of Out. */}
          <TableCell colSpan={3} className="p-0">
            <div
              id={detailId}
              className={`bg-muted/40 px-4 py-3 ${
                visibleWidth === null ? '' : 'sticky left-0'
              }`}
              // When the table overflows (phones), pin the panel to the visible area so
              // every amount is readable without scrolling sideways. When it fits, leave
              // layout untouched so amounts stay aligned under the "Out" column.
              style={visibleWidth === null ? undefined : { width: visibleWidth }}
            >
              <ul className="flex flex-col gap-2">
                {datedItems.map((item, idx) => (
                  <li
                    key={`${item.label}-${item.dueDate}-${idx}`}
                    // No wrapping: the label flexes and the amount stays fixed, so every
                    // amount lines up in one column. Allowing wrap put some amounts on
                    // their own line and broke the vertical alignment that makes a list
                    // of figures scannable.
                    className="flex items-baseline justify-between gap-x-4"
                  >
                    {/* whitespace-normal because TableCell sets nowrap: without it a long
                        vendor name runs straight under its own amount. */}
                    <span className="min-w-0 whitespace-normal text-sm text-foreground">
                      {item.label}
                      {/* The whole point of the feature: say plainly that this was due
                          earlier and is only sitting here because it has not cleared. */}
                      {item.daysOverdue > 0 && item.dueDate ? (
                        <span className="block text-xs text-muted-foreground">
                          Was due {formatDayLabel(item.dueDate)} —{' '}
                          {item.daysOverdue} {item.daysOverdue === 1 ? 'day' : 'days'} overdue,
                          still unpaid
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-foreground">
                      {formatCurrency(item.amount)}
                    </span>
                  </li>
                ))}

                {estimate ? (
                  <li className="flex items-baseline justify-between gap-x-4 border-t border-border pt-2">
                    <span className="min-w-0 whitespace-normal text-sm text-muted-foreground">
                      {estimate.label}
                      {/* Kept visually distinct from the named bills above. Presenting an
                          average as though it were a specific invoice would make the
                          total look more certain than it is. */}
                      <span className="block text-xs text-muted-foreground">
                        Estimated from your typical week, not a specific bill
                      </span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {formatCurrency(estimate.amount)}
                    </span>
                  </li>
                ) : null}
              </ul>
            </div>
          </TableCell>
          {/* Deliberately empty: an individual item has no running balance, and repeating
              the day's balance here would imply each line was settled on its own. */}
          <TableCell className="bg-muted/40 p-0" />
        </TableRow>
      ) : null}
    </>
  )
}
