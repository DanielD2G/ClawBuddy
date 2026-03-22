import { getGroupedTimezones, formatTimezone } from '@/lib/timezones'
import {
  DropdownMenu,
  DropdownMenuSearchable,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronsUpDown, Check } from 'lucide-react'

interface TimezoneSelectProps {
  value: string
  onChange: (tz: string) => void
  className?: string
}

export function TimezoneSelect({ value, onChange }: TimezoneSelectProps) {
  const grouped = getGroupedTimezones()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-8 w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 text-xs hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
          <span className="truncate">{formatTimezone(value)}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuSearchable placeholder="Search timezones...">
        {Object.entries(grouped).flatMap(([region, tzs]) => [
          <DropdownMenuLabel key={`label-${region}`}>{region}</DropdownMenuLabel>,
          ...tzs.map((tz) => (
            <DropdownMenuItem key={tz} onClick={() => onChange(tz)} className="gap-2">
              <span className="flex-1 truncate">{formatTimezone(tz)}</span>
              {value === tz && <Check className="size-3.5" />}
            </DropdownMenuItem>
          )),
        ])}
      </DropdownMenuSearchable>
    </DropdownMenu>
  )
}
