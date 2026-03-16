import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Wrench, FileText, Folder } from 'lucide-react'

type FileItem =
  | { kind: 'document'; id: string; label: string }
  | { kind: 'folder'; id: string; label: string }

interface MentionInputProps {
  value: string
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
  disabled?: boolean
  placeholder?: string
  onDocumentMentionsChange?: (documentIds: string[]) => void
  capabilities: Array<{ slug: string; name: string; description: string; icon: string | null }>
  documents: Array<{ id: string; title: string }>
  folders: Array<{ id: string; name: string }>
}

export function MentionInput({
  value,
  onChange,
  onFocus,
  onBlur,
  disabled,
  placeholder,
  onDocumentMentionsChange,
  capabilities,
  documents,
  folders,
}: MentionInputProps) {
  const readyDocuments = documents
  const enabledCapabilities = capabilities

  const fileItems = useMemo<FileItem[]>(() => [
    ...folders.map((f) => ({ kind: 'folder' as const, id: f.id, label: f.name })),
    ...readyDocuments.map((d) => ({ kind: 'document' as const, id: d.id, label: d.title })),
  ], [folders, readyDocuments])

  const [showPopover, setShowPopover] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mentionType, setMentionType] = useState<'tool' | 'file' | null>(null)
  const [mentionedDocIds, setMentionedDocIds] = useState<string[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Notify parent of document mention changes
  useEffect(() => {
    onDocumentMentionsChange?.(mentionedDocIds)
  }, [mentionedDocIds, onDocumentMentionsChange])

  // Track mentioned documents by scanning the value for @title patterns
  useEffect(() => {
    const ids: string[] = []
    for (const doc of readyDocuments) {
      if (value.includes(`@${doc.title}`)) {
        ids.push(doc.id)
      }
    }
    setMentionedDocIds((prev) => {
      if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return prev
      return ids
    })
  }, [value, readyDocuments])

  const filteredTools = useMemo(() =>
    enabledCapabilities.filter(
      (c) =>
        c.slug.includes(filter.toLowerCase()) ||
        c.name.toLowerCase().includes(filter.toLowerCase()),
    ),
    [enabledCapabilities, filter],
  )

  const filteredFiles = useMemo(() =>
    fileItems.filter((f) => f.label.toLowerCase().includes(filter.toLowerCase())),
    [fileItems, filter],
  )

  const filteredCount = mentionType === 'tool' ? filteredTools.length : filteredFiles.length

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  useEffect(() => {
    autoResize()
  }, [value, autoResize])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value
      onChange(newValue)

      const cursorPos = e.target.selectionStart ?? newValue.length
      const textBeforeCursor = newValue.slice(0, cursorPos)

      // Detect / trigger for tools
      const slashMatch = textBeforeCursor.match(/\/([a-z0-9-]*)$/)
      // Detect @ trigger for files/folders
      const atMatch = textBeforeCursor.match(/@([a-z0-9._\s-]*)$/i)

      if (slashMatch) {
        setMentionType('tool')
        setFilter(slashMatch[1])
        setShowPopover(true)
        setSelectedIndex(0)
      } else if (atMatch) {
        setMentionType('file')
        setFilter(atMatch[1])
        setShowPopover(true)
        setSelectedIndex(0)
      } else {
        setShowPopover(false)
        setMentionType(null)
      }
    },
    [onChange],
  )

  const insertMention = useCallback(
    (item: { type: 'tool'; slug: string } | { type: 'file'; label: string }) => {
      const cursorPos = inputRef.current?.selectionStart ?? value.length
      const textBeforeCursor = value.slice(0, cursorPos)

      if (item.type === 'tool') {
        const triggerIndex = textBeforeCursor.lastIndexOf('/')
        if (triggerIndex !== -1) {
          const before = value.slice(0, triggerIndex)
          const after = value.slice(cursorPos)
          onChange(`${before}/${item.slug} ${after}`)
        }
      } else {
        const triggerIndex = textBeforeCursor.lastIndexOf('@')
        if (triggerIndex !== -1) {
          const before = value.slice(0, triggerIndex)
          const after = value.slice(cursorPos)
          onChange(`${before}@${item.label} ${after}`)
        }
      }

      setShowPopover(false)
      setMentionType(null)
      inputRef.current?.focus()
    },
    [value, onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showPopover || !filteredCount) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % filteredCount)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + filteredCount) % filteredCount)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (showPopover && filteredCount > 0) {
          e.preventDefault()
          if (mentionType === 'tool') {
            insertMention({ type: 'tool', slug: filteredTools[selectedIndex].slug })
          } else {
            insertMention({ type: 'file', label: filteredFiles[selectedIndex].label })
          }
        }
      } else if (e.key === 'Escape') {
        setShowPopover(false)
        setMentionType(null)
      }
    },
    [showPopover, filteredCount, filteredTools, filteredFiles, selectedIndex, insertMention, mentionType],
  )

  // Close popover on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowPopover(false)
        setMentionType(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Build highlighted segments for the overlay
  const highlightedSegments = useMemo(() => {
    if (!value) return null

    const toolSlugs = new Set(enabledCapabilities.map((c) => c.slug))
    const fileLabels = new Set(fileItems.map((f) => f.label))

    // Build a regex that matches /slug or @label
    const patterns: string[] = []
    for (const slug of toolSlugs) patterns.push(`/${slug}(?=\\s|$)`)
    for (const label of fileLabels) patterns.push(`@${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)

    if (!patterns.length) return null

    const regex = new RegExp(`(${patterns.join('|')})`, 'g')
    const parts: { text: string; highlighted: boolean; type?: 'tool' | 'file' }[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(value)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: value.slice(lastIndex, match.index), highlighted: false })
      }
      const matchText = match[0]
      const type = matchText.startsWith('/') ? 'tool' : 'file'
      parts.push({ text: matchText, highlighted: true, type })
      lastIndex = regex.lastIndex
    }

    if (lastIndex < value.length) {
      parts.push({ text: value.slice(lastIndex), highlighted: false })
    }

    if (parts.every((p) => !p.highlighted)) return null
    return parts
  }, [value, enabledCapabilities, fileItems])

  return (
    <div className="relative flex-1">
      {/* Highlight overlay */}
      {highlightedSegments && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 text-base whitespace-pre-wrap break-words overflow-hidden"
        >
          {highlightedSegments.map((seg, i) =>
            seg.highlighted ? (
              <span
                key={i}
                className="text-brand"
              >
                {seg.text}
              </span>
            ) : (
              <span key={i} className="text-foreground">{seg.text}</span>
            ),
          )}
        </div>
      )}
      <textarea
        ref={inputRef}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={(e) => {
          // Submit on Enter (without Shift), let Shift+Enter create newline
          if (e.key === 'Enter' && !e.shiftKey && !showPopover) {
            e.preventDefault()
            const form = (e.target as HTMLElement).closest('form')
            form?.requestSubmit()
            return
          }
          handleKeyDown(e)
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        disabled={disabled}
        rows={1}
        className={`w-full bg-transparent text-base placeholder:text-muted-foreground/70 outline-none disabled:opacity-50 resize-none overflow-hidden ${
          highlightedSegments ? 'text-transparent caret-foreground' : 'text-foreground'
        }`}
      />

      {showPopover && filteredCount > 0 && (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto rounded-2xl border bg-popover p-1 shadow-lg"
        >
          {mentionType === 'tool' &&
            filteredTools.map((cap, i) => (
              <button
                key={cap.slug}
                type="button"
                className={`flex w-full items-center gap-2 rounded-full px-3 py-2 text-sm transition-colors ${
                  i === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-popover-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMention({ type: 'tool', slug: cap.slug })
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-medium">/{cap.slug}</span>
                <span className="text-muted-foreground truncate">{cap.name}</span>
              </button>
            ))}

          {mentionType === 'file' &&
            filteredFiles.map((item, i) => (
              <button
                key={item.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-full px-3 py-2 text-sm transition-colors ${
                  i === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'text-popover-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMention({ type: 'file', label: item.label })
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {item.kind === 'folder' ? (
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-medium">@{item.label}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
