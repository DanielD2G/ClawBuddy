import { useState, useMemo } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
// dnd-kit transforms are NOT applied to grid items (breaks CSS grid);
// visual drag feedback comes from <DragOverlay> only.
import {
  Trash2,
  Pencil,
  Check,
  Plus,
  Target,
  BarChart3,
  Activity,
  TableIcon,
  Sparkles,
  Link2,
  GripVertical,
  Code2,
  StickyNote,
  History,
} from 'lucide-react'
import type { DashboardComponent } from '@/hooks/use-dashboards'
import { ComponentRenderer } from './component-renderer'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/* ─── Grid span config per component type ─── */

/** Column span within the 3-column grid */
const COL_SPAN: Record<string, number> = {
  kpi: 1,
  stats_group: 3,
  chart: 3,
  ai_insights: 3,
  table: 3,
  links: 3,
}

/** Row span (each row unit ≈ auto-sized) */
const ROW_SPAN: Record<string, number> = {
  kpi: 1,
  stats_group: 1,
  chart: 1,
  ai_insights: 2,
  table: 1,
  links: 1,
}

function resolveColSpan(type: string, position: { w: number } | null, columns: number): number {
  const defaultSpan = COL_SPAN[type] ?? 1
  const explicit = position?.w ?? defaultSpan
  return Math.min(Math.max(explicit, 1), columns)
}

function resolveRowSpan(type: string, position: { h: number } | null): number {
  const defaultSpan = ROW_SPAN[type] ?? 1
  return position?.h ?? defaultSpan
}

/* ─── Component type palette for adding ─── */

const COMPONENT_TYPES = [
  { value: 'kpi', label: 'KPI', icon: Target },
  { value: 'stats_group', label: 'Stats Group', icon: Activity },
  { value: 'chart', label: 'Chart', icon: BarChart3 },
  { value: 'table', label: 'Table', icon: TableIcon },
  { value: 'ai_insights', label: 'AI Insights', icon: Sparkles },
  { value: 'links', label: 'Links / News', icon: Link2 },
] as const

type ComponentType = (typeof COMPONENT_TYPES)[number]['value']

const CHART_TYPES = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
]

/* ─── Props ─── */

type ComponentUpdates = {
  title?: string
  prompt?: string
  script?: string | null
  scriptLanguage?: string | null
  notes?: string | null
}

interface DashboardGridProps {
  components: DashboardComponent[]
  columns?: number
  gap?: number
  editing?: boolean
  onDeleteComponent?: (id: string, title: string | null) => void
  onMoveComponent?: (id: string, direction: 'up' | 'down') => void
  onUpdateComponent?: (id: string, updates: ComponentUpdates) => void
  onAddComponent?: (component: { type: string; title: string; prompt: string; config?: Record<string, unknown> }) => void
  onReorder?: (orderedIds: string[]) => void
}

/* ─── Sortable grid item ─── */

function SortableGridItem({
  component,
  columns,
  editing,
  isDropTarget,
  onDelete,
  onUpdate,
  children,
}: {
  component: DashboardComponent
  columns: number
  editing?: boolean
  isDropTarget?: boolean
  onDelete?: () => void
  onUpdate?: (updates: ComponentUpdates) => void
  children: React.ReactNode
}) {
  const colSpan = resolveColSpan(component.type, component.position as { w: number } | null, columns)
  const rowSpan = resolveRowSpan(component.type, component.position as { h: number } | null)

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({ id: component.id, disabled: !editing })

  // Responsive grid span classes:
  // - Mobile (1 col): always span 1
  // - Tablet (sm, 2 cols): KPIs span 1, wide components span 2
  // - Desktop (lg, 3 cols): use configured span
  const smSpan = Math.min(colSpan, 2)
  const lgSpan = colSpan

  const colSpanClass = cn(
    'col-span-1',
    smSpan === 2 && 'sm:col-span-2',
    lgSpan === 2 && 'lg:col-span-2',
    lgSpan === 3 && 'lg:col-span-3',
  )

  const rowStyle: React.CSSProperties = rowSpan > 1
    ? { gridRow: `span ${rowSpan} / span ${rowSpan}` }
    : {}

  return (
    <div
      ref={setNodeRef}
      style={rowStyle}
      className={cn(
        colSpanClass,
        'relative group/grid-item min-w-0 flex flex-col transition-all duration-200',
        isDragging && 'opacity-20 scale-95',
        isDropTarget && !isDragging && 'ring-2 ring-brand/50 rounded-xl scale-[1.02]',
      )}
      {...attributes}
    >
      {editing && (
        <div className="mb-2 rounded-xl border border-dashed border-brand/20 bg-muted/30 p-2 space-y-2">
          {/* Drag handle + delete — inline, no overlap */}
          <div className="flex items-center justify-between">
            <button
              {...listeners}
              className="flex items-center gap-1.5 cursor-grab rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
              title="Drag to reorder"
            >
              <GripVertical className="size-3.5" />
              <span className="select-none">Drag</span>
            </button>
            <button
              onClick={onDelete}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Remove component"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>

          {/* Editable name & prompt */}
          {onUpdate && (
            <EditableFields
              component={component}
              onSave={onUpdate}
            />
          )}
        </div>
      )}
      <div className={cn('flex-1 min-h-0 [&>*]:h-full')}>
        {children}
      </div>
    </div>
  )
}

/* ─── Script language options ─── */

const SCRIPT_LANGUAGES = [
  { value: 'python', label: 'Python' },
  { value: 'bash', label: 'Bash' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'sql', label: 'SQL' },
  { value: 'curl', label: 'cURL' },
] as const

/* ─── Editable fields (inline title/prompt/script/notes editing) ─── */

function EditableFields({
  component,
  onSave,
}: {
  component: DashboardComponent
  onSave: (updates: ComponentUpdates) => void
}) {
  const [editingField, setEditingField] = useState<'title' | 'prompt' | 'script' | 'notes' | null>(null)
  const [editValue, setEditValue] = useState('')
  const [expandedSection, setExpandedSection] = useState<'script' | 'notes' | 'history' | null>(null)

  const startEdit = (field: 'title' | 'prompt' | 'script' | 'notes') => {
    setEditingField(field)
    if (field === 'title') setEditValue(component.title || '')
    else if (field === 'prompt') setEditValue(component.prompt || '')
    else if (field === 'script') setEditValue(component.script || '')
    else if (field === 'notes') setEditValue(component.notes || '')
  }

  const commitEdit = () => {
    if (!editingField) return
    const trimmed = editValue.trim()
    if (editingField === 'title' && trimmed !== (component.title || '')) {
      onSave({ title: trimmed })
    }
    if (editingField === 'prompt' && trimmed !== (component.prompt || '')) {
      onSave({ prompt: trimmed })
    }
    if (editingField === 'script') {
      // Allow saving empty to clear script
      if (trimmed !== (component.script || '')) {
        onSave({ script: trimmed || null })
      }
    }
    if (editingField === 'notes') {
      if (trimmed !== (component.notes || '')) {
        onSave({ notes: trimmed || null })
      }
    }
    setEditingField(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // For multiline fields, only commit on Cmd/Ctrl+Enter
    const isMultiline = editingField === 'script' || editingField === 'notes'
    if (e.key === 'Enter' && !e.shiftKey && (!isMultiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      commitEdit()
    }
    if (e.key === 'Escape') {
      setEditingField(null)
    }
  }

  const toggleSection = (section: 'script' | 'notes' | 'history') => {
    setExpandedSection((prev) => (prev === section ? null : section))
    if (editingField) setEditingField(null)
  }

  const hasScript = !!component.script
  const hasNotes = !!component.notes
  const hasPreviousData = !!component.previousData

  return (
    <div className="space-y-1.5">
      {/* Title & Prompt — always visible */}
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2 space-y-1.5">
        {/* Title */}
        <InlineField
          label="Name"
          value={component.title || '(untitled)'}
          isEditing={editingField === 'title'}
          editValue={editValue}
          onStartEdit={() => startEdit('title')}
          onEditChange={setEditValue}
          onKeyDown={handleKeyDown}
          onCommit={commitEdit}
        />

        {/* Prompt */}
        <InlineField
          label="Prompt"
          value={component.prompt || '(no prompt)'}
          isEditing={editingField === 'prompt'}
          editValue={editValue}
          onStartEdit={() => startEdit('prompt')}
          onEditChange={setEditValue}
          onKeyDown={handleKeyDown}
          onCommit={commitEdit}
          multiline
          dimmed
        />
      </div>

      {/* Collapsible sections */}
      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => toggleSection('script')}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors',
            expandedSection === 'script'
              ? 'border-brand bg-brand/10 text-brand'
              : hasScript
                ? 'border-green-500/30 bg-green-500/5 text-green-600 dark:text-green-400'
                : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          <Code2 className="size-3" />
          Script{hasScript && ' *'}
        </button>
        <button
          onClick={() => toggleSection('notes')}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors',
            expandedSection === 'notes'
              ? 'border-brand bg-brand/10 text-brand'
              : hasNotes
                ? 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400'
                : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          <StickyNote className="size-3" />
          Notes{hasNotes && ' *'}
        </button>
        {hasPreviousData && (
          <button
            onClick={() => toggleSection('history')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors',
              expandedSection === 'history'
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <History className="size-3" />
            Previous
          </button>
        )}
      </div>

      {/* Script panel */}
      {expandedSection === 'script' && (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Regeneration Script
            </span>
            {/* Language selector */}
            <div className="flex gap-1">
              {SCRIPT_LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => onSave({ scriptLanguage: lang.value })}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                    component.scriptLanguage === lang.value
                      ? 'bg-brand/15 text-brand font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>
          {editingField === 'script' ? (
            <div className="space-y-1.5">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                rows={8}
                placeholder="# Script to fetch/generate data for this component&#10;# The agent will execute this during refresh&#10;&#10;import requests&#10;..."
                className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs leading-relaxed transition-colors outline-none resize-y placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">Ctrl+Enter to save, Esc to cancel</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEditingField(null)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={commitEdit}
                    className="rounded-md bg-brand px-2 py-1 text-xs text-white hover:bg-brand/90"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => startEdit('script')}
              className="group w-full text-left"
            >
              {component.script ? (
                <pre className="rounded-md border border-border bg-card p-2 font-mono text-xs leading-relaxed text-foreground/80 max-h-32 overflow-auto whitespace-pre-wrap group-hover:border-brand/30 transition-colors">
                  {component.script}
                </pre>
              ) : (
                <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground hover:border-brand/30 hover:text-brand transition-colors">
                  Click to add a script for data regeneration
                </div>
              )}
            </button>
          )}
        </div>
      )}

      {/* Notes panel */}
      {expandedSection === 'notes' && (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 space-y-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Agent Notes & Context
          </span>
          {editingField === 'notes' ? (
            <div className="space-y-1.5">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                rows={4}
                placeholder="Add context, instructions, or knowledge for the agent to use when regenerating this component..."
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-xs leading-relaxed transition-colors outline-none resize-y placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">Ctrl+Enter to save, Esc to cancel</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEditingField(null)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={commitEdit}
                    className="rounded-md bg-brand px-2 py-1 text-xs text-white hover:bg-brand/90"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => startEdit('notes')}
              className="group w-full text-left"
            >
              {component.notes ? (
                <p className="rounded-md border border-border bg-card p-2 text-xs leading-relaxed text-foreground/80 max-h-24 overflow-auto group-hover:border-brand/30 transition-colors">
                  {component.notes}
                </p>
              ) : (
                <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground hover:border-brand/30 hover:text-brand transition-colors">
                  Click to add notes & context for the agent
                </div>
              )}
            </button>
          )}
        </div>
      )}

      {/* Previous data panel */}
      {expandedSection === 'history' && component.previousData && (
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Previous Data (before last refresh)
            </span>
            <span className="text-[10px] text-muted-foreground">
              Updated {new Date(component.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          </div>
          <pre className="rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed text-foreground/70 max-h-48 overflow-auto whitespace-pre-wrap">
            {JSON.stringify(component.previousData, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

/* ─── Inline editable field (reusable) ─── */

function InlineField({
  label,
  value,
  isEditing,
  editValue,
  onStartEdit,
  onEditChange,
  onKeyDown,
  onCommit,
  multiline,
  dimmed,
}: {
  label: string
  value: string
  isEditing: boolean
  editValue: string
  onStartEdit: () => void
  onEditChange: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onCommit: () => void
  multiline?: boolean
  dimmed?: boolean
}) {
  return (
    <div className={cn('flex', multiline ? 'items-start' : 'items-center', 'gap-2')}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 w-12 shrink-0 pt-0.5">
        {label}
      </span>
      {isEditing ? (
        <div className={cn('flex flex-1', multiline ? 'items-start' : 'items-center', 'gap-1')}>
          {multiline ? (
            <textarea
              value={editValue}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={onCommit}
              autoFocus
              rows={2}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-xs transition-colors outline-none resize-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
          ) : (
            <Input
              value={editValue}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={onCommit}
              autoFocus
              className="h-7 text-xs"
            />
          )}
          <button
            onClick={onCommit}
            className={cn('shrink-0 rounded p-1 text-brand hover:bg-muted', multiline && 'mt-0.5')}
          >
            <Check className="size-3" />
          </button>
        </div>
      ) : (
        <button
          onClick={onStartEdit}
          className={cn(
            'flex flex-1 gap-1.5 text-left text-xs transition-colors group',
            multiline ? 'items-start' : 'items-center',
            dimmed ? 'text-muted-foreground hover:text-brand' : 'text-foreground hover:text-brand',
          )}
        >
          <span className={multiline ? 'line-clamp-2' : 'truncate'}>{value}</span>
          <Pencil className={cn('size-2.5 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity', multiline && 'mt-0.5')} />
        </button>
      )}
    </div>
  )
}

/* ─── Add component form ─── */

function AddComponentForm({
  onAdd,
}: {
  onAdd: (component: { type: string; title: string; prompt: string; config?: Record<string, unknown> }) => void
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ComponentType>('kpi')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [chartType, setChartType] = useState('line')

  const reset = () => {
    setType('kpi')
    setTitle('')
    setPrompt('')
    setChartType('line')
    setOpen(false)
  }

  const handleSubmit = () => {
    if (!title.trim()) return
    const comp: { type: string; title: string; prompt: string; config?: Record<string, unknown> } = {
      type,
      title: title.trim(),
      prompt: prompt.trim() || title.trim(),
    }
    if (type === 'chart') {
      comp.config = { chartType, xKey: 'x', yKey: 'y' }
    }
    onAdd(comp)
    reset()
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="col-span-full flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-muted-foreground/20 py-8 text-sm text-muted-foreground transition-colors hover:border-brand/40 hover:text-brand"
      >
        <Plus className="size-4" />
        Add Component
      </button>
    )
  }

  const typeInfo = COMPONENT_TYPES.find((t) => t.value === type)!
  const Icon = typeInfo.icon

  return (
    <div className="col-span-full rounded-xl border-2 border-dashed border-brand/30 bg-muted/20 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">New Component</span>
        <button onClick={reset} className="text-xs text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>

      {/* Type selector */}
      <div className="flex flex-wrap gap-1.5">
        {COMPONENT_TYPES.map((t) => {
          const TIcon = t.icon
          return (
            <button
              key={t.value}
              onClick={() => {
                setType(t.value)
                if (t.value !== 'chart') setChartType('line')
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                type === t.value
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
              )}
            >
              <TIcon className="size-3" />
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Chart sub-type */}
      {type === 'chart' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Chart type:</span>
          <div className="flex gap-1">
            {CHART_TYPES.map((ct) => (
              <button
                key={ct.value}
                onClick={() => setChartType(ct.value)}
                className={cn(
                  'rounded-md border px-2 py-1 text-xs transition-colors',
                  chartType === ct.value
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {ct.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Name */}
      <Input
        placeholder="Component name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="text-sm"
      />

      {/* Prompt */}
      <textarea
        placeholder="What data should this component show? (e.g. Fetch monthly revenue from Google Analytics)"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none resize-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      />

      <Button
        size="sm"
        className="gap-1.5"
        onClick={handleSubmit}
        disabled={!title.trim()}
      >
        <Plus className="size-3.5" />
        Add
      </Button>
    </div>
  )
}

/* ─── Main grid ─── */

export function DashboardGrid({
  components,
  columns = 3,
  gap = 5,
  editing,
  onDeleteComponent,
  onMoveComponent,
  onUpdateComponent,
  onAddComponent,
  onReorder,
}: DashboardGridProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor),
  )

  const sortedIds = useMemo(() => components.map((c) => c.id), [components])

  const activeComponent = useMemo(
    () => components.find((c) => c.id === activeId) ?? null,
    [components, activeId],
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }

  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id ? String(event.over.id) : null
    setOverId(overId !== activeId ? overId : null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null)
    setOverId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = sortedIds.indexOf(String(active.id))
    const newIndex = sortedIds.indexOf(String(over.id))
    if (oldIndex === -1 || newIndex === -1) return

    const newOrder = [...sortedIds]
    newOrder.splice(oldIndex, 1)
    newOrder.splice(newIndex, 0, String(active.id))

    // Use onReorder if available, otherwise fall back to move
    if (onReorder) {
      onReorder(newOrder)
    } else if (onMoveComponent) {
      // Fall back: compute direction for legacy API
      const direction = newIndex > oldIndex ? 'down' : 'up'
      onMoveComponent(String(active.id), direction)
    }
  }

  const handleDragCancel = () => {
    setActiveId(null)
    setOverId(null)
  }

  if (!components.length && !editing) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        This dashboard has no components yet.
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={sortedIds} strategy={rectSortingStrategy}>
        <div
          className="grid auto-rows-auto grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          style={{
            gap: `${gap * 4}px`,
          }}
        >
          {components.map((component) => (
            <SortableGridItem
              key={component.id}
              component={component}
              columns={columns}
              editing={editing}
              isDropTarget={overId === component.id}
              onDelete={() => onDeleteComponent?.(component.id, component.title)}
              onUpdate={(updates) => onUpdateComponent?.(component.id, updates)}
            >
              <ComponentRenderer component={component} />
            </SortableGridItem>
          ))}

          {/* Add Component button (in edit mode) */}
          {editing && onAddComponent && (
            <AddComponentForm onAdd={onAddComponent} />
          )}
        </div>
      </SortableContext>

      {/* Drag overlay — floating ghost that follows cursor */}
      <DragOverlay dropAnimation={{ duration: 200, easing: 'ease' }}>
        {activeComponent ? (
          <div className="rounded-xl ring-2 ring-brand/40 shadow-2xl opacity-90 pointer-events-none max-w-md">
            <ComponentRenderer component={activeComponent} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
