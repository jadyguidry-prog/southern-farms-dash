'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  PlaidAccountView,
  PlaidActionResult,
  PlaidOverview,
} from '@/app/settings/plaid-actions'

type Props = {
  overview: PlaidOverview
  onSaveMapping: (formData: FormData) => Promise<PlaidActionResult>
  onSync: () => Promise<PlaidActionResult>
  onDisconnect: (formData: FormData) => Promise<PlaidActionResult>
}

function formatWhen(value: string | null): string {
  if (!value) return 'Never'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** The day after a date string, which is the safe first day to import. */
function dayAfter(date: string | null): string {
  if (!date) return ''
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Plaid does not support Link inside an iframe — their docs are explicit that the
 * session "may fail or close unexpectedly" because Link expects a top-level browsing
 * context (it renders its own iframe internally, which cannot be nested inside a
 * cross-origin one). The embedded preview pane is exactly that case, so Link can be
 * launched there, accept an institution, and then vanish with no useful explanation.
 */
function inIframe() {
  try {
    return window.self !== window.top
  } catch {
    // Cross-origin access to window.top throws, which itself means we are framed.
    return true
  }
}

const IFRAME_MESSAGE =
  'this page is running inside an embedded preview, which Plaid does not support. Open it in its own browser tab and connect again.'

/**
 * Plain-English remedies for Plaid exit codes that are *account configuration*
 * problems rather than anything wrong in this app — raw codes give the owner no
 * idea that the fix is a Plaid Dashboard setting.
 */
const EXIT_REMEDIES: Record<string, string> = {
  // Since 2024-10-31 every new US/Canada account must pick a Data Transparency
  // Messaging use case before Link works in Production. Ruled out by probe on
  // 2026-08-10: the `default` customization EXISTS and matches US/en (a bogus name
  // fails differently, with INVALID_FIELD "not found"), so the only remaining cause
  // is a missing use case. The use-case picker is its OWN section, not inside the
  // "Consent" row — link straight to it rather than describing where to click.
  INVALID_LINK_CUSTOMIZATION:
    'no Data Transparency Messaging use case is selected on the "default" Link customization. Open dashboard.plaid.com/link/data-transparency-v5, pick a use case, then "Publish changes". Required for Production; not an app problem.',
  INVALID_LINK_TOKEN:
    'the token expired or was already used — close this and click Connect again.',
  INVALID_API_KEYS:
    'PLAID_SECRET does not match PLAID_ENV. Check both in the project environment variables.',
  INSTITUTION_NOT_RESPONDING:
    "the bank's own connection is down right now. Nothing to fix here — try again later.",
}

/**
 * Mounts Plaid Link for exactly one token and opens it exactly once.
 *
 * This is deliberately a separate component. Previously `usePlaidLink` lived in the
 * panel itself and was opened from an effect that depended on `open`. Because the
 * SDK returns a NEW `open` function on every render — and it destroys/recreates the
 * underlying Link instance whenever the token changes — that effect re-fired and
 * stacked multiple Link instances. The browser logged "link-initialize.js was
 * embedded more than once", the user's completed flow was bound to a torn-down
 * instance, and `onSuccess` never fired: Link appeared to work but nothing was ever
 * exchanged or saved.
 *
 * Isolating it means the hook is only ever created with a real token, and unmounting
 * (token -> null) fully tears the instance down.
 */
function PlaidLinkLauncher({
  token,
  receivedRedirectUri,
  onSuccess,
  onExit,
}: {
  token: string
  receivedRedirectUri?: string
  onSuccess: (publicToken: string) => void
  onExit: (message: string | null) => void
}) {
  const opened = useRef(false)

  const { open, ready } = usePlaidLink({
    token,
    // Set only when returning from an OAuth bank. It tells Link to resume the
    // in-flight authorisation instead of starting a fresh institution picker.
    ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
    onSuccess: (publicToken) => {
      // The SDK types public_token as nullable. Without a token there is nothing to
      // exchange, so surface it rather than POSTing null to the server.
      if (!publicToken) {
        onExit('Plaid did not return a token. Nothing was connected — try again.')
        return
      }
      onSuccess(publicToken)
    },
    // Plaid passes a second `metadata` argument that this previously threw away,
    // which is why a failure could only ever report "Plaid Link closed" with no
    // way to tell a user cancelling from the institution refusing the session.
    // `status` names the pane the owner exited from, and `request_id` /
    // `link_session_id` are what Plaid Support needs to trace it.
    onExit: (err, metadata) => {
      if (!err) {
        // No error: the owner closed Link deliberately. Silent, except when it
        // died on the very first pane, which is what an iframe block looks like.
        onExit(
          metadata?.status === 'institution_not_found' || !metadata?.status
            ? inIframe()
              ? IFRAME_MESSAGE
              : null
            : null,
        )
        return
      }

      const parts = [
        err.display_message ?? err.error_message ?? err.error_code ?? 'unknown error',
      ]
      if (err.error_code && err.error_code !== err.display_message) {
        parts.push(`(${err.error_code})`)
      }
      if (metadata?.status) parts.push(`— closed at: ${metadata.status}`)

      const remedy = err.error_code ? EXIT_REMEDIES[err.error_code] : undefined
      if (remedy) parts.push(`· ${remedy}`)

      const trace = [
        metadata?.request_id ? `request ${metadata.request_id}` : null,
        metadata?.link_session_id ? `session ${metadata.link_session_id}` : null,
      ].filter(Boolean)

      onExit(
        `Plaid Link closed: ${parts.join(' ')}${trace.length ? ` · ${trace.join(', ')}` : ''}${
          inIframe() ? ` · ${IFRAME_MESSAGE}` : ''
        }`,
      )
    },
  })

  // Fires once per mounted token. The ref guard is what prevents the re-open loop.
  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true
      open()
    }
  }, [ready, open])

  return null
}

/** Holds the in-flight link token across an OAuth navigation away and back. */
const OAUTH_TOKEN_KEY = 'plaid_link_token_in_flight'

function clearInFlightToken() {
  try {
    window.localStorage.removeItem(OAUTH_TOKEN_KEY)
  } catch {
    // Storage unavailable; nothing was stored either.
  }
}

export function PlaidIntegrationPanel({
  overview,
  onSaveMapping,
  onSync,
  onDisconnect,
}: Props) {
  const [result, setResult] = useState<PlaidActionResult | null>(null)
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  // Non-null only while finishing an OAuth hand-back.
  const [oauthRedirectUri, setOauthRedirectUri] = useState<string | undefined>(undefined)

  const ready = overview.configured && overview.encryptionConfigured

  // Resolved after mount: `window` is unavailable during SSR, and rendering the
  // notice on the server would hydrate mismatched.
  const [framed, setFramed] = useState(false)
  useEffect(() => setFramed(inIframe()), [])

  /**
   * Resume an OAuth connection.
   *
   * OAuth banks (American Express, and most large institutions) navigate the whole
   * browser to the bank's site, so every bit of React state is destroyed. Plaid
   * returns the owner to the registered redirect URI carrying `?oauth_state_id=`,
   * and Link must then be re-created with the ORIGINAL link token plus
   * `receivedRedirectUri`. A fresh token would restart the picker and silently lose
   * the authorisation the owner just completed at their bank.
   *
   * The token therefore has to outlive the navigation, which means storage rather
   * than state. It is a short-lived token that cannot read data by itself.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!new URLSearchParams(window.location.search).has('oauth_state_id')) return

    const stored = window.localStorage.getItem(OAUTH_TOKEN_KEY)
    if (!stored) {
      // Landed on an OAuth return without the token — usually a different browser
      // or cleared storage. Say so instead of showing an inert page.
      setResult({
        ok: false,
        message:
          'The bank sent you back, but this browser no longer has the connection in progress. Start "Connect a bank or card" again in this same browser.',
      })
      return
    }
    setOauthRedirectUri(window.location.href)
    setLinkToken(stored)
    setLinking(true)
  }, [])

  function run(label: string, action: () => Promise<PlaidActionResult>) {
    setPendingLabel(label)
    setResult(null)
    startTransition(async () => {
      try {
        setResult(await action())
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : 'Unexpected error.',
        })
      } finally {
        setPendingLabel(null)
      }
    })
  }

  // Exchange happens server-side; the browser only ever holds the short-lived
  // public token.
  const onLinkSuccess = useCallback(async (publicToken: string) => {
    setLinking(true)
    setResult(null)
    try {
      const res = await fetch('/api/plaid/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicToken }),
      })
      const data = await res.json()
      if (!data.ok) {
        setResult({ ok: false, message: data.error ?? 'Could not finish connecting.' })
      } else {
        setResult({
          ok: true,
          message: `Connected ${data.institutionName ?? 'your bank'}. Found ${data.accounts?.length ?? 0} account(s) — map each one below before anything imports.`,
        })
        // Reload so the new accounts appear with their mapping form.
        window.location.reload()
      }
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Could not finish connecting.',
      })
    } finally {
      setLinking(false)
      setLinkToken(null)
      setOauthRedirectUri(undefined)
      // The token is single-use once exchanged; leaving it behind would make the
      // next page load think an OAuth flow was still in progress.
      clearInFlightToken()
    }
  }, [])

  // Link closed without finishing, or errored. Clearing the token unmounts the
  // launcher so a later attempt starts from a clean instance.
  const handleLinkExit = useCallback((message: string | null) => {
    setLinkToken(null)
    setOauthRedirectUri(undefined)
    setLinking(false)
    clearInFlightToken()
    if (message) setResult({ ok: false, message })
  }, [])

  async function startLink(itemId?: string) {
    setLinking(true)
    setResult(null)
    try {
      const res = await fetch('/api/plaid/link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemId ? { itemId } : {}),
      })
      const data = await res.json()
      if (!data.ok) {
        setResult({ ok: false, message: data.error ?? 'Could not start Plaid Link.' })
        setLinking(false)
        return
      }
      // Persist before opening: an OAuth bank may navigate away immediately, and
      // the token must still be here when the browser comes back.
      try {
        window.localStorage.setItem(OAUTH_TOKEN_KEY, data.linkToken)
      } catch {
        // Private browsing can refuse writes. Non-OAuth banks still work, so
        // continue rather than blocking the whole flow.
      }
      setOauthRedirectUri(undefined)
      setLinkToken(data.linkToken)
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Could not start Plaid Link.',
      })
      setLinking(false)
    }
  }

  const totalMapped = overview.items.reduce(
    (sum, item) => sum + item.accounts.filter((a) => a.isEnabled && a.accountName).length,
    0,
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Bank &amp; card feeds (Plaid)</CardTitle>
            <CardDescription>
              Pulls checking and credit card transactions automatically each night, so
              the ledger no longer depends on downloading CSVs by hand.
            </CardDescription>
          </div>
          {ready ? (
            <Badge variant={overview.environment === 'production' ? 'default' : 'secondary'}>
              {overview.environment === 'production' ? 'Production' : 'Sandbox'}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Mounted only while a token is live, so exactly one Link instance exists. */}
        {linkToken && (
          <PlaidLinkLauncher
            token={linkToken}
            receivedRedirectUri={oauthRedirectUri}
            onSuccess={onLinkSuccess}
            onExit={handleLinkExit}
          />
        )}

        {!overview.configured && (
          <div className="rounded-lg border border-dashed p-4">
            <p className="text-sm font-medium">Add your Plaid keys to get started</p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                Create a Plaid account, then open Team Settings → Keys in the Plaid
                dashboard.
              </li>
              <li>
                Add <code className="font-mono text-xs">PLAID_CLIENT_ID</code> and{' '}
                <code className="font-mono text-xs">PLAID_SECRET</code> in Project
                Settings → Vars.
              </li>
              <li>
                Add <code className="font-mono text-xs">PLAID_ENCRYPTION_KEY</code> —
                generate it with{' '}
                <code className="font-mono text-xs">openssl rand -base64 32</code>.
              </li>
              <li>
                Leave <code className="font-mono text-xs">PLAID_ENV</code> unset for
                sandbox testing, or set it to{' '}
                <code className="font-mono text-xs">production</code> for real accounts.
              </li>
            </ol>
          </div>
        )}

        {overview.configured && !overview.encryptionConfigured && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <p className="text-sm font-medium">Encryption key missing</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Plaid access tokens can read your full bank history, so they are never
              stored unencrypted. Add{' '}
              <code className="font-mono text-xs">PLAID_ENCRYPTION_KEY</code> (
              <code className="font-mono text-xs">openssl rand -base64 32</code>) before
              connecting an account.
            </p>
          </div>
        )}

        {ready && framed && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">Open this page in its own tab to connect</p>
            <p className="mt-1 text-muted-foreground">
              Plaid does not support its login window inside an embedded preview — it
              will accept your bank and then close without connecting.{' '}
              <a
                href="/settings"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-2"
              >
                Open Settings in a new tab
              </a>
              , then use Connect there.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!ready || linking || isPending}
            onClick={() => void startLink()}
          >
            {linking ? 'Opening Plaid…' : 'Connect a bank or card'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!ready || isPending || overview.items.length === 0}
            onClick={() => run('sync', onSync)}
          >
            {pendingLabel === 'sync' ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>

        {result && (
          <div
            role="status"
            className={`rounded-lg border p-3 text-sm ${
              result.ok
                ? 'border-primary/30 bg-primary/5 text-foreground'
                : 'border-destructive/40 bg-destructive/5 text-foreground'
            }`}
          >
            <p className="font-medium">{result.message}</p>
            {result.detail && result.detail.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {result.detail.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {overview.items.length === 0 ? (
          ready && (
            <p className="text-sm text-muted-foreground">
              No banks connected yet. Nothing is estimated or filled in with sample
              data — connect an account and map it to start importing.
            </p>
          )
        ) : (
          <>
            <Separator />
            <div className="space-y-4">
              {overview.items.map((item) => (
                <div key={item.itemId} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {item.institutionName ?? 'Connected institution'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Last successful sync: {formatWhen(item.lastSuccessAt)}
                      </p>
                      {(item.lastError || item.syncError) && (
                        <p className="mt-1 break-words text-xs text-destructive">
                          {item.lastError ?? item.syncError}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          item.status === 'active'
                            ? 'default'
                            : item.status === 'reauth_required'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {item.status === 'reauth_required'
                          ? 'needs sign-in'
                          : item.status}
                      </Badge>
                      {item.status === 'reauth_required' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={linking}
                          onClick={() => void startLink(item.itemId)}
                        >
                          Reconnect
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isPending}
                        onClick={() =>
                          run(`disconnect-${item.itemId}`, () => {
                            const fd = new FormData()
                            fd.set('itemId', item.itemId)
                            return onDisconnect(fd)
                          })
                        }
                      >
                        {pendingLabel === `disconnect-${item.itemId}`
                          ? 'Disconnecting…'
                          : 'Disconnect'}
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 space-y-3">
                    {item.accounts.map((account) => (
                      <AccountMappingRow
                        key={account.accountId}
                        account={account}
                        existingAccounts={overview.existingAccounts}
                        disabled={isPending}
                        onSave={(fd) =>
                          run(`map-${account.accountId}`, () => onSaveMapping(fd))
                        }
                        saving={pendingLabel === `map-${account.accountId}`}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              {totalMapped === 0
                ? 'No accounts are mapped yet, so the nightly sync will not import anything.'
                : `${totalMapped} account${totalMapped === 1 ? '' : 's'} mapped and importing nightly at 9:00 UTC.`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function AccountMappingRow({
  account,
  existingAccounts,
  disabled,
  saving,
  onSave,
}: {
  account: PlaidAccountView
  existingAccounts: PlaidOverview['existingAccounts']
  disabled: boolean
  saving: boolean
  onSave: (formData: FormData) => void
}) {
  const [accountName, setAccountName] = useState(account.accountName ?? '')
  const [importFrom, setImportFrom] = useState(account.importFromDate ?? '')
  const [enabled, setEnabled] = useState(account.isEnabled)

  const matched = existingAccounts.find((e) => e.accountName === accountName)
  // The safe cutover: the day after the last transaction already in the ledger for
  // that account, so Plaid picks up exactly where the CSV history stopped.
  const suggestedDate = dayAfter(matched?.latest ?? null)

  function submit() {
    const fd = new FormData()
    fd.set('accountId', account.accountId)
    fd.set('accountName', accountName)
    fd.set('importFromDate', importFrom)
    if (enabled) fd.set('isEnabled', 'on')
    onSave(fd)
  }

  const label = [account.plaidName, account.mask ? `••${account.mask}` : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label || account.accountId}</p>
          <p className="text-xs text-muted-foreground">
            {[account.type, account.subtype].filter(Boolean).join(' · ') || 'account'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label
            htmlFor={`enabled-${account.accountId}`}
            className="text-xs text-muted-foreground"
          >
            Import
          </Label>
          <Switch
            id={`enabled-${account.accountId}`}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={disabled}
          />
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`name-${account.accountId}`} className="text-xs">
            Maps to existing account
          </Label>
          <Select
            value={accountName}
            onValueChange={(value) => {
              const next = value ?? ''
              setAccountName(next)
              // Fill the cutover with the day after that account's last imported
              // transaction. Only when the field is still empty, so a date the owner
              // deliberately chose is never overwritten. The suggestion link below
              // remains for changing it afterwards.
              if (!importFrom) {
                const suggestion = dayAfter(
                  existingAccounts.find((e) => e.accountName === next)?.latest ?? null,
                )
                if (suggestion) setImportFrom(suggestion)
              }
            }}
            disabled={disabled}
          >
            <SelectTrigger id={`name-${account.accountId}`} className="text-sm">
              <SelectValue placeholder="Choose an account…" />
            </SelectTrigger>
            <SelectContent>
              {existingAccounts.map((e) => (
                <SelectItem key={e.accountName} value={e.accountName}>
                  {e.accountName} ({e.rows.toLocaleString()} rows)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Must match exactly, or this account&apos;s history splits into two in every
            report.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`from-${account.accountId}`} className="text-xs">
            Import transactions from
          </Label>
          <Input
            id={`from-${account.accountId}`}
            type="date"
            value={importFrom}
            onChange={(e) => setImportFrom(e.target.value)}
            disabled={disabled}
            className="text-sm"
          />
          {suggestedDate && importFrom !== suggestedDate ? (
            <button
              type="button"
              className="text-left text-xs text-primary underline underline-offset-2"
              onClick={() => setImportFrom(suggestedDate)}
            >
              Use {suggestedDate} — the day after the last imported transaction
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Anything before this date is skipped, so already-imported CSV history is
              never duplicated.
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" onClick={submit} disabled={disabled}>
          {saving ? 'Saving…' : 'Save mapping'}
        </Button>
      </div>
    </div>
  )
}
