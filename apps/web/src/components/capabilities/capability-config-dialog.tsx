import { useState } from 'react'
import { Check, ChevronsUpDown, Eye, EyeOff } from 'lucide-react'
import type { ConfigFieldDefinition } from '@/types/capability-config'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface CapabilityConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  capabilityName: string
  schema: ConfigFieldDefinition[]
  initialValues?: Record<string, unknown>
  onSubmit: (config: Record<string, unknown>) => void
  isLoading?: boolean
}

export function CapabilityConfigDialog({
  open,
  onOpenChange,
  capabilityName,
  schema,
  initialValues,
  onSubmit,
  isLoading,
}: CapabilityConfigDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of schema) {
      const existing = initialValues?.[field.key]
      initial[field.key] = existing != null ? String(existing) : (field.default ?? '')
    }
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({})

  function validate(): boolean {
    const newErrors: Record<string, string> = {}
    for (const field of schema) {
      if (field.required && !values[field.key]?.trim()) {
        newErrors[field.key] = `${field.label} is required`
      }
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    const config: Record<string, unknown> = {}
    for (const field of schema) {
      if (values[field.key] !== '') {
        config[field.key] = values[field.key]
      }
    }
    onSubmit(config)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Configure {capabilityName}</DialogTitle>
          <DialogDescription>Enter the required credentials and settings.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {schema.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <label htmlFor={field.key} className="text-sm font-medium leading-none">
                {field.label}
                {field.required && <span className="ml-0.5 text-destructive">*</span>}
              </label>
              {field.description && (
                <p className="text-xs text-muted-foreground">{field.description}</p>
              )}
              {field.type === 'select' && field.options ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
                      <span>{field.options?.find((o) => o.value === values[field.key])?.label || 'Select...'}</span>
                      <ChevronsUpDown className="size-4 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {field.options.map((opt) => (
                      <DropdownMenuItem
                        key={opt.value}
                        onClick={() => setValues((prev) => ({ ...prev, [field.key]: opt.value }))}
                        className="gap-2"
                      >
                        <span className="flex-1">{opt.label}</span>
                        {values[field.key] === opt.value && <Check className="size-3.5" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : field.type === 'textarea' ? (
                <textarea
                  id={field.key}
                  value={values[field.key]}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                  aria-invalid={!!errors[field.key]}
                  rows={6}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                />
              ) : field.type === 'password' ? (
                <div className="relative">
                  <Input
                    id={field.key}
                    type={showPasswords[field.key] ? 'text' : 'password'}
                    value={values[field.key]}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [field.key]: e.target.value,
                      }))
                    }
                    placeholder={field.placeholder}
                    aria-invalid={!!errors[field.key]}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() =>
                      setShowPasswords((prev) => ({
                        ...prev,
                        [field.key]: !prev[field.key],
                      }))
                    }
                  >
                    {showPasswords[field.key] ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </Button>
                </div>
              ) : (
                <Input
                  id={field.key}
                  type="text"
                  value={values[field.key]}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder={field.placeholder}
                  aria-invalid={!!errors[field.key]}
                />
              )}
              {errors[field.key] && <p className="text-xs text-destructive">{errors[field.key]}</p>}
            </div>
          ))}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
