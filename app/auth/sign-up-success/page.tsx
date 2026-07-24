import { Button } from '@/components/ui/button'
import { MailCheck } from 'lucide-react'
import Link from 'next/link'

export default function SignUpSuccessPage() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-sidebar p-6 md:p-10">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-lg">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <MailCheck className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold text-card-foreground">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We&apos;ve sent a confirmation link to your inbox. Confirm your email to
          activate your account, then sign in to access the dashboard.
        </p>
        <Button className="mt-6 w-full" render={<Link href="/auth/login" />}>
          Back to sign in
        </Button>
      </div>
    </div>
  )
}
