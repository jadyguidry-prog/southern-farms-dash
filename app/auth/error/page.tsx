import { Button } from '@/components/ui/button'
import { AlertTriangle } from 'lucide-react'
import Link from 'next/link'

export default function AuthErrorPage() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-sidebar p-6 md:p-10">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-lg">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold text-card-foreground">
          Authentication error
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong while signing you in. The link may have expired or
          already been used. Please try signing in again.
        </p>
        <Button className="mt-6 w-full" nativeButton={false} render={<Link href="/auth/login" />}>
          Back to sign in
        </Button>
      </div>
    </div>
  )
}
