import { cn } from '@/lib/utils'
import { Minus, Plus } from 'lucide-react'

interface NumberInputProps {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  className?: string
}

export function NumberInput({
  value,
  onChange,
  min = 0,
  max = Infinity,
  step = 1,
  suffix,
  className,
}: NumberInputProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  return (
    <div
      className={cn(
        'inline-flex items-center gap-0 rounded-md border border-border bg-muted/40 dark:bg-muted/20',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onChange(clamp(value - step))}
        disabled={value <= min}
        className="flex items-center justify-center size-7 text-muted-foreground hover:text-foreground hover:bg-muted/70 dark:hover:bg-muted/40 rounded-l-md transition-colors disabled:opacity-30 disabled:pointer-events-none"
      >
        <Minus className="size-3" />
      </button>
      <div className="flex items-center justify-center min-w-[2.5rem] px-1 tabular-nums text-xs font-mono select-none">
        {value}
        {suffix && <span className="text-muted-foreground ml-0.5">{suffix}</span>}
      </div>
      <button
        type="button"
        onClick={() => onChange(clamp(value + step))}
        disabled={value >= max}
        className="flex items-center justify-center size-7 text-muted-foreground hover:text-foreground hover:bg-muted/70 dark:hover:bg-muted/40 rounded-r-md transition-colors disabled:opacity-30 disabled:pointer-events-none"
      >
        <Plus className="size-3" />
      </button>
    </div>
  )
}
