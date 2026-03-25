import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { SourcesFooter, type Source } from './sources-footer'

interface DataTableProps {
  title?: string | null
  config: {
    columns: Array<{
      key: string
      label: string
      align?: 'left' | 'center' | 'right'
    }>
  }
  data: {
    rows: Array<Record<string, unknown>>
    sources?: Source[]
  } | null
}

export function DataTable({ title, config, data }: DataTableProps) {
  const rows = data?.rows ?? []

  // Auto-detect columns from data keys if none configured
  const columns: Array<{ key: string; label: string; align?: 'left' | 'center' | 'right' }> =
    config.columns?.length
      ? config.columns
      : rows.length
        ? Object.keys(rows[0]).map((key) => ({
            key,
            label: key
              .replace(/([A-Z])/g, ' $1')
              .replace(/[_-]/g, ' ')
              .replace(/^\w/, (c) => c.toUpperCase())
              .trim(),
          }))
        : []

  return (
    <Card className="h-full py-5 md:py-6">
      {title && (
        <CardHeader className="px-5 md:px-6">
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="px-5 md:px-6">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No data available</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className={cn(
                      col.align === 'center' && 'text-center',
                      col.align === 'right' && 'text-right',
                    )}
                  >
                    {col.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      className={cn(
                        col.align === 'center' && 'text-center',
                        col.align === 'right' && 'text-right',
                      )}
                    >
                      {row[col.key] != null ? String(row[col.key]) : '—'}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <SourcesFooter sources={data?.sources} />
      </CardContent>
    </Card>
  )
}
