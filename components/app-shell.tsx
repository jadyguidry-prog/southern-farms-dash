'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  LayoutDashboard,
  Banknote,
  Package,
  Users,
  ShoppingCart,
  Truck,
  Receipt,
  ListChecks,
  Store,
  Landmark,
  Wallet,
  Sparkles,
  Settings,
  ShieldCheck,
  Menu,
  X,
  Beef,
  Bell,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { createClient } from '@/lib/supabase/client'

// Navigation is grouped so related modules sit together. Every existing route is
// preserved — only the visual grouping changed.
const navSections = [
  {
    label: null,
    items: [{ label: 'Dashboard', href: '/', icon: LayoutDashboard }],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Inventory', href: '/inventory', icon: Package },
      { label: 'Payroll', href: '/payroll', icon: Users },
      { label: 'Sales', href: '/sales', icon: ShoppingCart },
    ],
  },
  {
    label: 'Business',
    items: [
      { label: 'Vendor Management', href: '/vendors', icon: Truck },
      { label: 'Transactions', href: '/vendors/transactions', icon: Receipt },
      { label: 'Category Review', href: '/category-review', icon: ListChecks },
      { label: 'Wholesale Customers', href: '/wholesale', icon: Store },
    ],
  },
  {
    label: 'Financial',
    items: [
      { label: 'Cash Flow', href: '/cash-flow', icon: Banknote },
      { label: 'Cash & Debt', href: '/cash-debt', icon: Wallet },
      { label: 'Loans', href: '/loans', icon: Landmark },
    ],
  },
  {
    label: 'Tools',
    items: [
      { label: 'AI Advisor', href: '/ai-advisor', icon: Sparkles },
      { label: 'Admin', href: '/admin', icon: ShieldCheck },
      { label: 'Settings', href: '/settings', icon: Settings },
    ],
  },
]

const allHrefs = navSections.flatMap((s) => s.items.map((i) => i.href))

/** True when `href` is a prefix of the current path (its own page or a child). */
function matchesPath(pathname: string, href: string) {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * Highlight a link for its own page and detail pages beneath it, but let the
 * MOST specific link win. Otherwise `/vendors/transactions` would light up both
 * "Vendor Management" (/vendors) and "Transactions".
 */
function resolveActiveHref(pathname: string) {
  return allHrefs
    .filter((href) => matchesPath(pathname, href))
    .sort((a, b) => b.length - a.length)[0]
}

function initialsFromEmail(email: string | null) {
  if (!email) return 'SF'
  const name = email.split('@')[0]
  const parts = name.split(/[._-]+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return letters.toUpperCase()
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const activeHref = resolveActiveHref(pathname)
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  const handleSignOut = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/auth/login')
    router.refresh()
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-3 border-b border-sidebar-border px-6 py-5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
          <Beef className="size-5" aria-hidden="true" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight text-white">Southern Farms</p>
          <p className="text-xs text-sidebar-foreground/70">Specialty Meats</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
        {navSections.map((section, index) => (
          <div key={section.label ?? 'primary'} className={index > 0 ? 'mt-5' : undefined}>
            {section.label && (
              <p className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
                {section.label}
              </p>
            )}
            <div className="space-y-1">
              {section.items.map((item) => {
                const active = activeHref === item.href
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm'
                        : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-9">
            <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-white">
              {initialsFromEmail(email)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-white">
              {email ?? 'Co-op Staff'}
            </p>
            <p className="truncate text-xs text-sidebar-foreground/70">Signed in</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          className="mt-3 w-full justify-start gap-2 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-white"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </Button>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Auth pages render without the dashboard chrome.
  if (pathname.startsWith('/auth')) {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 w-64">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border bg-card/95 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
            >
              <Menu className="size-5" />
            </Button>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Operations Center · v1
              </p>
              <h1 className="text-sm font-semibold text-foreground md:text-base">
                Financial Command Dashboard
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground sm:flex">
              <span className="size-1.5 rounded-full bg-chart-2" aria-hidden="true" />
              Live · FY2026
            </span>
            <Button variant="outline" size="icon" aria-label="Notifications">
              <Bell className="size-4" />
            </Button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>

      {mobileOpen && (
        <button
          className="sr-only"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation menu"
        >
          <X />
        </button>
      )}
    </div>
  )
}
