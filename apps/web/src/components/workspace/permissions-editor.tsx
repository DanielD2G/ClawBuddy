import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Plus, X, ShieldCheck, Save } from 'lucide-react'
import { EXAMPLE_PERMISSION_RULES } from '@/constants'

interface PermissionsEditorProps {
  workspaceId: string
  permissions: { allow?: string[] } | null
}

export function PermissionsEditor({ workspaceId, permissions }: PermissionsEditorProps) {
  const [rules, setRules] = useState<string[]>(permissions?.allow ?? [])
  const [newRule, setNewRule] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const queryClient = useQueryClient()

  useEffect(() => {
    setRules(permissions?.allow ?? [])
    setIsDirty(false)
  }, [permissions])

  const updateMutation = useMutation({
    mutationFn: (newPermissions: { allow: string[] } | null) =>
      apiClient.patch(`/workspaces/${workspaceId}`, {
        permissions: newPermissions,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] })
      setIsDirty(false)
    },
  })

  const addRule = () => {
    if (!newRule.trim()) return
    setRules((prev) => [...prev, newRule.trim()])
    setNewRule('')
    setIsDirty(true)
  }

  const removeRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index))
    setIsDirty(true)
  }

  const save = () => {
    updateMutation.mutate(rules.length > 0 ? { allow: rules } : null)
  }

  const isEnabled = permissions !== null || rules.length > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Tool Permissions</h3>
            <p className="text-xs text-muted-foreground">
              {isEnabled
                ? 'Only matching commands run automatically. Others require approval.'
                : 'No rules configured. All tools execute without approval.'}
            </p>
          </div>
        </div>
      </div>

      {/* Rules list */}
      <div className="space-y-2">
        {rules.map((rule, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5"
          >
            <code className="flex-1 text-xs font-mono">{rule}</code>
            <button
              type="button"
              onClick={() => removeRule(i)}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Add rule */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newRule}
          onChange={(e) => setNewRule(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addRule()}
          placeholder="e.g. Bash(aws s3 ls *)"
          className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm font-mono placeholder:text-muted-foreground/50"
        />
        <Button variant="outline" size="sm" onClick={addRule} disabled={!newRule.trim()}>
          <Plus className="size-4" />
          Add
        </Button>
      </div>

      {/* Quick add examples */}
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLE_PERMISSION_RULES.filter((r) => !rules.includes(r))
          .slice(0, 3)
          .map((rule) => (
            <button
              key={rule}
              type="button"
              onClick={() => {
                setRules((prev) => [...prev, rule])
                setIsDirty(true)
              }}
              className="rounded-full border px-2.5 py-0.5 text-[11px] font-mono text-muted-foreground hover:bg-muted transition-colors"
            >
              + {rule}
            </button>
          ))}
      </div>

      {/* Save */}
      {isDirty && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={updateMutation.isPending}>
            <Save className="size-4" />
            {updateMutation.isPending ? 'Saving...' : 'Save Permissions'}
          </Button>
        </div>
      )}
    </div>
  )
}
