import * as React from 'react'

import { cn } from '@/lib/utils'

interface SwitchProps {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  size?: 'sm' | 'default'
  id?: string
  name?: string
}

function Switch({
  checked = false,
  onCheckedChange,
  disabled = false,
  className,
  size = 'default',
  ...props
}: SwitchProps) {
  const handleClick = () => {
    if (!disabled) {
      onCheckedChange?.(!checked)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      handleClick()
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      data-size={size}
      disabled={disabled}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        size === 'default' ? 'h-[18.4px] w-[32px]' : 'h-[14px] w-[24px]',
        checked ? 'bg-primary' : 'bg-input dark:bg-input/80',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-background ring-0 transition-transform',
          size === 'default' ? 'size-4' : 'size-3',
          checked
            ? 'translate-x-[calc(100%-2px)] dark:bg-primary-foreground'
            : 'translate-x-0 dark:bg-foreground',
        )}
      />
    </button>
  )
}

export { Switch }
