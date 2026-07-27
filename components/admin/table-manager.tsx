'use client'

import Link from 'next/link'
import { Info, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RecordForm } from './record-form'
import { CsvImport } from './csv-import'
import { RecordsTable } from './records-table'
import type { TableDef } from '@/lib/admin-config'

export function TableManager({
  def,
  rows,
}: {
  def: TableDef
  rows: Record<string, unknown>[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{def.label}</CardTitle>
        <CardDescription>{def.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {def.managedElsewhere ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-3 rounded-lg border border-border bg-secondary/50 p-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {def.managedElsewhere.reason}
              </p>
            </div>
            <Link href={def.managedElsewhere.href} className="w-full sm:w-auto">
              <Button variant="outline" className="w-full sm:w-auto">
                {def.managedElsewhere.linkLabel}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <div className="pt-1">
              <p className="mb-2 text-sm font-medium text-foreground">
                Current records ({rows.length})
              </p>
              <RecordsTable def={def} rows={rows} />
            </div>
          </div>
        ) : (
        <Tabs defaultValue="add">
          <TabsList>
            <TabsTrigger value="add">Add record</TabsTrigger>
            <TabsTrigger value="import">CSV import</TabsTrigger>
            <TabsTrigger value="records">
              Current records ({rows.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="add" className="pt-4">
            <RecordForm def={def} />
          </TabsContent>
          <TabsContent value="import" className="pt-4">
            <CsvImport def={def} />
          </TabsContent>
          <TabsContent value="records" className="pt-4">
            <RecordsTable def={def} rows={rows} />
          </TabsContent>
        </Tabs>
        )}
      </CardContent>
    </Card>
  )
}
