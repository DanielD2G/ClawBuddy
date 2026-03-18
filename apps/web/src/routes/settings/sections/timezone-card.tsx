import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { toast } from 'sonner'
import { Globe } from 'lucide-react'
import { TimezoneSelect } from '@/components/timezone-select'

export function TimezoneCard() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['model-config'],
    queryFn: () => apiClient.get<{ timezone?: string }>('/settings/models'),
  })

  const timezone = data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  const saveMutation = useMutation({
    mutationFn: (tz: string) => apiClient.patch('/settings/models', { timezone: tz }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model-config'] })
      toast.success('Timezone updated')
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update timezone')
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-5" />
          Timezone
        </CardTitle>
        <CardDescription>
          Set the timezone used for scheduling and time-based features.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading...</div>}

        {!isLoading && (
          <div className="flex flex-col gap-1.5">
            <TimezoneSelect
              value={timezone}
              onChange={(tz) => saveMutation.mutate(tz)}
              className="h-8 w-full rounded-full border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Auto-detected from your browser. Change if needed.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
