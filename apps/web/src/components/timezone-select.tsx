import { getGroupedTimezones, formatTimezone } from '@/lib/timezones'

interface TimezoneSelectProps {
  value: string
  onChange: (tz: string) => void
  className?: string
}

export function TimezoneSelect({
  value,
  onChange,
  className = 'h-8 w-full rounded-full border bg-background px-3 text-xs',
}: TimezoneSelectProps) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {Object.entries(getGroupedTimezones()).map(([region, tzs]) => (
        <optgroup key={region} label={region}>
          {tzs.map((tz) => (
            <option key={tz} value={tz}>
              {formatTimezone(tz)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
