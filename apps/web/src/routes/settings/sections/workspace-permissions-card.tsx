import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Plus, Save, X } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EXAMPLE_PERMISSION_RULES } from '@/constants'
import { useActiveWorkspace } from '@/providers/workspace-provider'

export function WorkspacePermissionsCard() {
  const queryClient = useQueryClient()
  const { activeWorkspaceId } = useActiveWorkspace()
  const [newRule, setNewRule] = useState('')
  const [localRules, setLocalRules] = useState<string[] | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['settings-permissions'],
    queryFn: () =>
      apiClient.get<{ permissions: { allow?: string[] } | null }>(
        `/workspaces/${activeWorkspaceId}/settings`,
      ),
    enabled: !!activeWorkspaceId,
  })

  const rules = localRules ?? data?.permissions?.allow ?? []
  const isDirty = localRules !== null

  const saveMutation = useMutation({
    mutationFn: (allow: string[]) =>
      apiClient.patch(`/workspaces/${activeWorkspaceId}/settings`, {
        permissions: { allow },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings-permissions'] })
      queryClient.invalidateQueries({ queryKey: ['workspace-settings', activeWorkspaceId] })
      queryClient.invalidateQueries({ queryKey: ['workspaces', activeWorkspaceId] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      setLocalRules(null)
    },
  })

  const addRule = () => {
    if (!newRule.trim()) return
    setLocalRules([...rules, newRule.trim()])
    setNewRule('')
  }

  const removeRule = (index: number) => {
    setLocalRules(rules.filter((_, i) => i !== index))
  }

  if (!activeWorkspaceId) {
    return (
      <div>
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">Tool Permissions</h2>
            <p className="text-sm text-muted-foreground">
              Select a workspace to manage its auto-approval rules.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) return null

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="size-5 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold">Tool Permissions</h2>
          <p className="text-sm text-muted-foreground">
            {rules.length > 0
              ? 'Matching commands run automatically in this workspace. Others require user approval.'
              : 'No rules configured — all tool executions require user approval in this workspace.'}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 py-4">
          {rules.length > 0 && (
            <div className="space-y-1.5">
              {rules.map((rule, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5"
                >
                  <code className="flex-1 text-xs font-mono">{rule}</code>
                  <button
                    type="button"
                    onClick={() => removeRule(i)}
                    className="text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              type="text"
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRule()}
              placeholder="e.g. Docker(ps *)"
              className="flex-1 h-(--control-sm) rounded-md border bg-background px-3 text-sm font-mono placeholder:text-muted-foreground/50"
            />
            <Button variant="outline" onClick={addRule} disabled={!newRule.trim()}>
              <Plus className="size-4" />
              Add
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_PERMISSION_RULES.filter((rule) => !rules.includes(rule))
              .slice(0, 4)
              .map((rule) => (
                <button
                  key={rule}
                  type="button"
                  onClick={() => setLocalRules([...rules, rule])}
                  className="rounded-full border px-2.5 py-0.5 text-[11px] font-mono text-muted-foreground transition-colors hover:bg-muted"
                >
                  + {rule}
                </button>
              ))}
          </div>

          {isDirty && (
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => saveMutation.mutate(rules)}
                disabled={saveMutation.isPending}
              >
                <Save className="size-4" />
                {saveMutation.isPending ? 'Saving...' : 'Save Permissions'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
