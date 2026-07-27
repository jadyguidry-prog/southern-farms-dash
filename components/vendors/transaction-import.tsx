'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import Papa from 'papaparse'
import { Upload, FileSpreadsheet, AlertTriangle, CheckCircle2, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/data'
import {
  guessColumnRoles,
  normalizeDescription,
  parseAmount,
  parseDate,
  inferTransactionType,
  canonicalizeSign,
  AMOUNT_CONVENTIONS,
  AMOUNT_CONVENTION_LABELS,
  type AmountConvention,
  type ColumnRole,
} from '@/lib/transactions'
import { commitImport, previewImport, type StagedRow } from '@/app/vendors/import/actions'

const ROLE_LABELS: Record<ColumnRole, string> = {
  ignore: 'Ignore this column',
  transaction_date: 'Transaction date',
  posted_date: 'Posted date',
  description: 'Description / payee',
  amount: 'Amount (signed)',
  debit: 'Debit (money out)',
  credit: 'Credit (money in)',
  transaction_type: 'Type',
  account_name: 'Account name',
  external_transaction_id: 'Bank transaction ID',
  expense_category: 'Category',
}

type ParsedFile = {
  fileName: string
  headers: string[]
  rows: Record<string, string>[]
}

type BuiltRow = StagedRow & {
  rowNumber: number
  normalized: string
  error: string | null
}

export function TransactionImport({ accountNames }: { accountNames: string[] }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [roles, setRoles] = useState<Record<string, ColumnRole>>({})
  const [accountName, setAccountName] = useState('')
  const [convention, setConvention] = useState<AmountConvention>('bank')
  const [overrideDuplicates, setOverrideDuplicates] = useState(false)
  const [duplicateKeys, setDuplicateKeys] = useState<Set<string> | null>(null)
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<{
    imported: number
    duplicates: number
    matched: number
    unmatched: number
  } | null>(null)

  function handleFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (output) => {
        const headers = (output.meta.fields ?? []).filter(Boolean)
        if (headers.length === 0) {
          toast.error('That file has no readable column headers.')
          return
        }
        setParsed({ fileName: file.name, headers, rows: output.data })
        setRoles(guessColumnRoles(headers))
        setDuplicateKeys(null)
        setResult(null)
      },
      error: (err) => toast.error(`Could not read the file: ${err.message}`),
    })
  }

  // Turn the raw CSV rows into staged transactions using the current mapping.
  // Rows that can't be read are kept with an `error` so they are visible on
  // screen instead of silently disappearing from the import.
  const built = useMemo<BuiltRow[]>(() => {
    if (!parsed) return []

    const columnFor = (role: ColumnRole) =>
      parsed.headers.find((h) => roles[h] === role) ?? null

    const dateCol = columnFor('transaction_date')
    const postedCol = columnFor('posted_date')
    const descCol = columnFor('description')
    const amountCol = columnFor('amount')
    const debitCol = columnFor('debit')
    const creditCol = columnFor('credit')
    const typeCol = columnFor('transaction_type')
    const accountCol = columnFor('account_name')
    const extIdCol = columnFor('external_transaction_id')
    const categoryCol = columnFor('expense_category')

    return parsed.rows.map((raw, index) => {
      const rowNumber = index + 2 // +1 for header, +1 for 1-based
      const errors: string[] = []

      const date = dateCol ? parseDate(raw[dateCol]) : null
      if (!date) errors.push('unreadable date')

      const description = descCol ? String(raw[descCol] ?? '').trim() : ''
      if (!description) errors.push('missing description')

      // Either a single signed amount column, or separate debit/credit columns.
      let signed: number | null = null
      if (amountCol) {
        signed = parseAmount(raw[amountCol])
      } else if (debitCol || creditCol) {
        const debit = debitCol ? parseAmount(raw[debitCol]) : null
        const credit = creditCol ? parseAmount(raw[creditCol]) : null
        if (debit != null && debit !== 0) signed = -Math.abs(debit)
        else if (credit != null && credit !== 0) signed = Math.abs(credit)
        else if (debit != null || credit != null) signed = 0
      }
      if (signed == null) errors.push('unreadable amount')

      const normalized = normalizeDescription(description)

      // Put the amount into the canonical "negative = money out" convention
      // before inferring the type, so a credit-card file (purchases positive)
      // isn't misread as income. The stored amount is a magnitude regardless.
      const canonicalSigned =
        signed == null ? 0 : canonicalizeSign(signed, convention)

      // A type column from the bank is respected only when it matches a type we
      // understand; otherwise we infer from the description and direction.
      const rawType = typeCol ? String(raw[typeCol] ?? '').trim().toLowerCase() : ''
      const knownType = [
        'expense',
        'payment',
        'credit',
        'refund',
        'transfer',
        'fee',
        'interest',
        'income',
      ].includes(rawType)
        ? (rawType as StagedRow['transactionType'])
        : null

      return {
        rowNumber,
        transactionDate: date ?? '',
        postedDate: postedCol ? parseDate(raw[postedCol]) : null,
        description,
        amount: signed ?? 0,
        transactionType:
          knownType ?? inferTransactionType(normalized, canonicalSigned),
        accountName:
          (accountCol ? String(raw[accountCol] ?? '').trim() : '') ||
          accountName ||
          null,
        externalTransactionId: extIdCol
          ? String(raw[extIdCol] ?? '').trim() || null
          : null,
        expenseCategory: categoryCol
          ? String(raw[categoryCol] ?? '').trim() || null
          : null,
        normalized,
        error: errors.length > 0 ? errors.join(', ') : null,
      }
    })
  }, [parsed, roles, accountName, convention])

  const validRows = built.filter((r) => r.error === null)
  const errorRows = built.filter((r) => r.error !== null)

  const hasRequiredMapping =
    Object.values(roles).includes('transaction_date') &&
    Object.values(roles).includes('description') &&
    (Object.values(roles).includes('amount') ||
      Object.values(roles).includes('debit') ||
      Object.values(roles).includes('credit'))

  function runPreview() {
    startTransition(async () => {
      const staged = validRows.map(stripRow)
      const res = await previewImport(staged)
      setDuplicateKeys(new Set(res.duplicateKeys))
      toast.success(
        `${res.matchedCount} of ${staged.length} rows matched a vendor. ${res.duplicateKeys.length} look like duplicates.`,
      )
    })
  }

  function runImport() {
    if (!parsed) return
    startTransition(async () => {
      const res = await commitImport(
        parsed.fileName,
        validRows.map(stripRow),
        overrideDuplicates,
      )
      if (!res.ok) {
        toast.error(res.error ?? 'Import failed.')
        return
      }
      setResult(res)
      toast.success(`Imported ${res.imported} transactions.`)
    })
  }

  function reset() {
    setParsed(null)
    setRoles({})
    setDuplicateKeys(null)
    setResult(null)
    setOverrideDuplicates(false)
    if (fileInput.current) fileInput.current.value = ''
  }

  if (result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-5 w-5 text-chart-2" />
            Import complete
          </CardTitle>
          <CardDescription>{parsed?.fileName}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <SummaryStat label="Imported" value={result.imported} />
            <SummaryStat label="Skipped as duplicates" value={result.duplicates} />
            <SummaryStat label="Matched to a vendor" value={result.matched} />
            <SummaryStat label="Need review" value={result.unmatched} />
          </dl>
          {result.unmatched > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              {result.unmatched}{' '}
              {result.unmatched === 1 ? 'transaction' : 'transactions'} could not be
              matched to a vendor with confidence. Review them on the Transactions
              tab and assign a vendor to teach the matcher for next time.
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={reset}>Import another file</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Choose a CSV file</CardTitle>
          <CardDescription>
            Export transactions from your bank or credit card as CSV, then upload it
            here. Nothing is saved until you review the preview below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="mr-2 h-4 w-4" />
                Select CSV file
              </Button>
              {parsed && (
                <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <FileSpreadsheet className="h-4 w-4 shrink-0" />
                  <span className="truncate">{parsed.fileName}</span>
                  <span className="shrink-0">({parsed.rows.length} rows)</span>
                </span>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="account-name">
                  Account name
                  <span className="ml-1 font-normal text-muted-foreground">
                    (used when the file has no account column)
                  </span>
                </Label>
                <Input
                  id="account-name"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="e.g. Operating Checking"
                  list="known-accounts"
                  className="mt-1.5"
                />
                <datalist id="known-accounts">
                  {accountNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>

              <div>
                <Label htmlFor="amount-convention">Statement type</Label>
                <Select
                  value={convention}
                  onValueChange={(v) => setConvention((v as AmountConvention) ?? 'bank')}
                >
                  <SelectTrigger id="amount-convention" className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AMOUNT_CONVENTIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {AMOUNT_CONVENTION_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Credit-card exports list purchases as positive numbers. Pick the
                  matching type so spend is counted correctly.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {parsed && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Confirm the columns</CardTitle>
            <CardDescription>
              We guessed these from the headers. Correct anything that is wrong —
              the import only uses what you confirm here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {parsed.headers.map((header) => (
                <div key={header}>
                  <Label className="truncate" htmlFor={`role-${header}`}>
                    {header}
                  </Label>
                  <Select
                    value={roles[header] ?? 'ignore'}
                    onValueChange={(v) =>
                      setRoles((prev) => ({ ...prev, [header]: v as ColumnRole }))
                    }
                  >
                    <SelectTrigger id={`role-${header}`} className="mt-1.5">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ROLE_LABELS) as ColumnRole[]).map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    e.g. {String(parsed.rows[0]?.[header] ?? '—')}
                  </p>
                </div>
              ))}
            </div>

            {!hasRequiredMapping && (
              <p className="mt-4 flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                Map a transaction date, a description, and either an amount column or
                a debit/credit pair before continuing.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {parsed && hasRequiredMapping && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Review before importing</CardTitle>
            <CardDescription>
              {validRows.length} of {built.length} rows are readable
              {errorRows.length > 0 && `, ${errorRows.length} have problems`}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={runPreview}
                disabled={isPending || validRows.length === 0}
              >
                Check for duplicates and matches
              </Button>
              {duplicateKeys && (
                <Badge variant="secondary">
                  <Copy className="mr-1 h-3 w-3" />
                  {duplicateKeys.size} duplicate{duplicateKeys.size === 1 ? '' : 's'}{' '}
                  found
                </Badge>
              )}
            </div>

            {duplicateKeys && duplicateKeys.size > 0 && (
              <label className="mt-4 flex items-start gap-3 rounded-lg border border-border p-3">
                <Checkbox
                  checked={overrideDuplicates}
                  onCheckedChange={(v) => setOverrideDuplicates(v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  <span className="font-medium">Import duplicates anyway.</span>{' '}
                  <span className="text-muted-foreground">
                    Leave this off to skip rows already on file. Turn it on only if
                    the repeated charges are genuinely separate purchases.
                  </span>
                </span>
              </label>
            )}

            {errorRows.length > 0 && (
              <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  {errorRows.length} row{errorRows.length === 1 ? '' : 's'} will be
                  skipped
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {errorRows.slice(0, 5).map((r) => (
                    <li key={r.rowNumber} className="text-xs text-muted-foreground">
                      Row {r.rowNumber}: {r.error}
                    </li>
                  ))}
                  {errorRows.length > 5 && (
                    <li className="text-xs text-muted-foreground">
                      …and {errorRows.length - 5} more
                    </li>
                  )}
                </ul>
              </div>
            )}

            <div className="mt-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {built.slice(0, 25).map((row) => (
                    <TableRow key={row.rowNumber}>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {row.transactionDate || '—'}
                      </TableCell>
                      <TableCell className="max-w-[22rem]">
                        <span className="block truncate">{row.description || '—'}</span>
                        {row.normalized && row.normalized !== row.description && (
                          <span className="block truncate text-xs text-muted-foreground">
                            reads as: {row.normalized}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">
                          {row.transactionType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatCurrency(Math.abs(row.amount))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {built.length > 25 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the first 25 of {built.length} rows.
                </p>
              )}
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                type="button"
                onClick={runImport}
                disabled={isPending || validRows.length === 0}
              >
                {isPending ? 'Importing…' : `Import ${validRows.length} transactions`}
              </Button>
              <Button type="button" variant="ghost" onClick={reset}>
                Start over
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-semibold">{value}</dd>
    </div>
  )
}

/** Drop the client-only preview fields before sending rows to the server. */
function stripRow(row: BuiltRow): StagedRow {
  return {
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    description: row.description,
    amount: row.amount,
    transactionType: row.transactionType,
    accountName: row.accountName,
    externalTransactionId: row.externalTransactionId,
    expenseCategory: row.expenseCategory,
  }
}
