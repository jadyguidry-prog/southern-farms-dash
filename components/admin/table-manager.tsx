'use client'

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
      </CardContent>
    </Card>
  )
}
