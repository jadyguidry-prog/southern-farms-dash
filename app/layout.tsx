import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Libre_Franklin, JetBrains_Mono } from 'next/font/google'
import { AppShell } from '@/components/app-shell'
import './globals.css'

const libreFranklin = Libre_Franklin({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Southern Farms Operations Center',
  description:
    'Executive financial dashboard for Southern Farms Specialty Meats — cash flow, inventory, payroll, sales, and AI-driven insights.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#1e2a52',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`light ${libreFranklin.variable} ${jetbrainsMono.variable} bg-background`}
    >
      <body className="font-sans antialiased">
        <AppShell>{children}</AppShell>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
