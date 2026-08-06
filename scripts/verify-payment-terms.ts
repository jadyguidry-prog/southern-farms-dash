/**
 * Payment terms: label <-> days mapping, due-date derivation, and the resolver's
 * precedence rules.
 *
 * The scenario driving this: Sysco moved to Net 21 and delivers weekly, sometimes twice a
 * week, but each invoice is due 21 days from ITS OWN bill date. So terms must derive a
 * per-invoice deadline WITHOUT turning the vendor into a recurring bill.
 */
import {
  PAYMENT_TERM_OPTIONS,
  PAYMENT_TERM_LABELS,
  termsToDays,
  daysToTermsLabel,
  addDaysISO,
  deriveDueDate,
} from '../lib/payment-terms'
import { resolveNextDueDate } from '../lib/health'

let pass = 0
let fail = 0

function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function ok(name: string, cond: boolean) {
  check(name, cond, true)
}

console.log('\n1. Net 21 exists and maps to 21 days')
{
  ok('Net 21 is selectable', PAYMENT_TERM_LABELS.includes('Net 21'))
  check('Net 21 -> 21', termsToDays('Net 21'), 21)
  check('21 -> "Net 21"', daysToTermsLabel(21), 'Net 21')
}

console.log('\n2. Prepaid and Due on Receipt are NOT the same thing')
{
  // The trap: collapsing these to one value. 'Due on Receipt' is a real same-day
  // deadline (0); 'Prepaid' has no receivable clock at all (null). Treating Prepaid as 0
  // would make every prepaid vendor instantly overdue the moment a bill is entered.
  check('Due on Receipt -> 0', termsToDays('Due on Receipt'), 0)
  check('Prepaid -> null', termsToDays('Prepaid'), null)
  ok('0 and null are distinct', termsToDays('Due on Receipt') !== termsToDays('Prepaid'))

  // And that distinction must survive derivation.
  check(
    'Due on Receipt derives a same-day due date',
    deriveDueDate('2026-08-05', 0),
    '2026-08-05',
  )
  check(
    'Prepaid derives nothing (falls back to entered date)',
    deriveDueDate('2026-08-05', null),
    '',
  )
}

console.log('\n3. Terms parsing tolerates hand-typed history')
{
  check('lowercase', termsToDays('net 21'), 21)
  check('no space', termsToDays('Net21'), 21)
  check('"21 days"', termsToDays('21 days'), 21)
  check('bare number string', termsToDays('21'), 21)
  check('bare number', termsToDays(21), 21)
  check('blank -> null', termsToDays(''), null)
  check('null -> null', termsToDays(null), null)
  check('nonsense -> null', termsToDays('whenever'), null)
  // A negative term would compute a due date BEFORE the invoice existed.
  check('negative -> null', termsToDays(-5), null)
  // An unlisted but valid imported value still round-trips rather than vanishing.
  check('unlisted 37 -> "Net 37"', daysToTermsLabel(37), 'Net 37')
}

console.log('\n4. Date arithmetic stays on the local calendar')
{
  check('Aug 5 + 21 = Aug 26', addDaysISO('2026-08-05', 21), '2026-08-26')
  // Month boundary.
  check('Aug 20 + 21 = Sep 10', addDaysISO('2026-08-20', 21), '2026-09-10')
  // Year boundary.
  check('Dec 25 + 21 = Jan 15', addDaysISO('2026-12-25', 21), '2027-01-15')
  // Leap year: 2028 is a leap year, so Feb has 29 days.
  check('Feb 20 2028 + 21 = Mar 12', addDaysISO('2028-02-20', 21), '2028-03-12')
  // The timezone regression: a date must never come back as the previous day.
  ok('no UTC off-by-one', addDaysISO('2026-08-05', 0) === '2026-08-05')
  check('garbage date -> empty', addDaysISO('not-a-date', 21), '')
}

console.log('\n5. Derivation requires BOTH parts')
{
  // Deriving from half the information would overwrite a real deadline with a guess.
  check('no invoice date -> empty', deriveDueDate(null, 21), '')
  check('no terms -> empty', deriveDueDate('2026-08-05', null), '')
  check('both present -> derived', deriveDueDate('2026-08-05', 21), '2026-08-26')
}

console.log('\n6. Resolver: derived terms outrank a hand-typed placeholder')
{
  const today = new Date('2026-08-05T00:00:00')

  // The exact Sysco case. A bill entered today with a placeholder due date of today,
  // but invoiced today on Net 21, is due Aug 26 — NOT today.
  check(
    'Sysco: invoice Aug 5 + Net 21 = Aug 26, not the placeholder',
    resolveNextDueDate(
      {
        dueDate: '2026-08-05',
        nextDueDate: '',
        recurring: false,
        frequency: 'One-time',
        invoiceDate: '2026-08-05',
        paymentTermsDays: 21,
      },
      today,
    ),
    '2026-08-26',
  )

  // A derived date must NOT be rolled forward by frequency. Rolling would invent a
  // deadline for an invoice that does not exist yet.
  check(
    'a derived date is never rolled forward',
    resolveNextDueDate(
      {
        dueDate: '',
        nextDueDate: '',
        recurring: true,
        frequency: 'Weekly',
        invoiceDate: '2026-06-01',
        paymentTermsDays: 21,
      },
      today,
    ),
    // June 1 + 21 = June 22, which is in the PAST. It stays there: a past-due invoice
    // really is late, and advancing it would hide a genuine problem.
    '2026-06-22',
  )
}

console.log('\n7. Existing behaviour is untouched when terms are absent')
{
  const today = new Date('2026-08-05T00:00:00')

  // This is what keeps the migration additive: every row without an invoice date
  // behaves exactly as it did before.
  check(
    'recurring bill with no terms still rolls forward (MediaRite)',
    resolveNextDueDate(
      {
        dueDate: '2026-01-15',
        nextDueDate: '2026-06-15',
        recurring: true,
        frequency: 'Monthly',
      },
      today,
    ),
    '2026-08-15',
  )
  check(
    'one-off past due with no terms stays past due',
    resolveNextDueDate(
      { dueDate: '2026-07-01', nextDueDate: '', recurring: false, frequency: '' },
      today,
    ),
    '2026-07-01',
  )
  check(
    'nothing scheduled at all -> empty',
    resolveNextDueDate(
      { dueDate: '', nextDueDate: '', recurring: false, frequency: '' },
      today,
    ),
    '',
  )
  // Partial terms data must not hijack the old path.
  check(
    'invoice date but no terms -> falls back to entered date',
    resolveNextDueDate(
      {
        dueDate: '2026-09-01',
        nextDueDate: '',
        recurring: false,
        frequency: '',
        invoiceDate: '2026-08-05',
        paymentTermsDays: null,
      },
      today,
    ),
    '2026-09-01',
  )
}

console.log('\n8. Every option maps consistently in both directions')
{
  // Guards the drift this module exists to prevent: a label whose number disagrees
  // with the number's label.
  for (const opt of PAYMENT_TERM_OPTIONS) {
    check(`${opt.label} round-trips`, termsToDays(opt.label), opt.days)
  }
  // Net terms must be strictly ascending so the dropdown reads sensibly.
  const nets = PAYMENT_TERM_OPTIONS.filter((o) => o.days != null).map((o) => o.days!)
  ok(
    'net terms are in ascending order',
    nets.every((n, i) => i === 0 || n > nets[i - 1]),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
