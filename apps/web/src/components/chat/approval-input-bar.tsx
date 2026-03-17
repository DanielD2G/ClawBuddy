import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, ChevronUp, ChevronDown as ChevronDownIcon, CornerDownLeft } from 'lucide-react'
import type { PendingApproval } from '@/hooks/use-chat'
import { CODE_APPROVAL_PREVIEW_LEN } from '@/constants'

function formatCapabilityName(slug?: string): string {
  if (!slug) return 'Tool'
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function getApprovalPreview(approval: PendingApproval): string {
  const args = approval.input
  if (args.command) return String(args.command)
  if (args.code) return String(args.code).slice(0, CODE_APPROVAL_PREVIEW_LEN) + (String(args.code).length > CODE_APPROVAL_PREVIEW_LEN ? '...' : '')
  if (args.query) return String(args.query)
  if (args.path) return String(args.path)
  return ''
}

function computeAllowRule(approval: PendingApproval): string {
  const args = approval.input
  const command = String(args.command ?? '')

  switch (approval.toolName) {
    case 'run_bash': {
      const tokens = command.split(/\s+/).filter(Boolean)
      const prefix = tokens.slice(0, 2).join(' ')
      return prefix ? `Bash(${prefix} *)` : 'Bash(*)'
    }
    case 'aws_command': {
      const tokens = command.split(/\s+/).filter(Boolean)
      const prefix = tokens[0] ?? ''
      return prefix ? `Bash(aws ${prefix} *)` : 'Bash(aws *)'
    }
    case 'kubectl_command': {
      const tokens = command.split(/\s+/).filter(Boolean)
      const prefix = tokens[0] ?? ''
      return prefix ? `Bash(kubectl ${prefix} *)` : 'Bash(kubectl *)'
    }
    case 'docker_command': {
      const tokens = command.split(/\s+/).filter(Boolean)
      const prefix = tokens[0] ?? ''
      return prefix ? `Bash(docker ${prefix} *)` : 'Bash(docker *)'
    }
    case 'run_python':
      return 'Python(*)'
    case 'read_file':
    case 'list_files':
      return 'Read(*)'
    case 'write_file':
      return 'Write(*)'
    default:
      return `${approval.toolName}(*)`
  }
}

const APPROVAL_OPTIONS = ['Yes', 'Yes, always in this session', 'Yes, always', 'No, skip this action']

export interface ApprovalInputBarProps {
  approvals: PendingApproval[]
  onDecision: (approvalId: string, decision: 'approved' | 'denied', allowRule?: string, scope?: 'session' | 'global') => void
}

export function ApprovalInputBar({ approvals, onDecision }: ApprovalInputBarProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const handleSubmit = useCallback(() => {
    const allowRule = approvals.length === 1 ? computeAllowRule(approvals[0]) : undefined
    if (selectedIndex === 0) {
      approvals.forEach(a => onDecision(a.approvalId, 'approved'))
    } else if (selectedIndex === 1) {
      approvals.forEach(a => onDecision(a.approvalId, 'approved', allowRule ?? computeAllowRule(a), 'session'))
    } else if (selectedIndex === 2) {
      approvals.forEach(a => onDecision(a.approvalId, 'approved', allowRule ?? computeAllowRule(a), 'global'))
    } else {
      approvals.forEach(a => onDecision(a.approvalId, 'denied'))
    }
  }, [selectedIndex, approvals, onDecision])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => (prev - 1 + APPROVAL_OPTIONS.length) % APPROVAL_OPTIONS.length)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => (prev + 1) % APPROVAL_OPTIONS.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        approvals.forEach(a => onDecision(a.approvalId, 'denied'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSubmit, approvals, onDecision])

  const preview = approvals.length === 1 ? getApprovalPreview(approvals[0]) : ''
  const rulePreview = approvals.length === 1 ? computeAllowRule(approvals[0]) : null

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-muted/60 px-5 py-4 space-y-3">
      {/* Header: what needs approval */}
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-amber-500 shrink-0" />
        <span className="text-sm text-foreground">
          {approvals.length === 1
            ? `Allow ${formatCapabilityName(approvals[0].capabilitySlug)} to run?`
            : `Allow ${approvals.length} actions to run?`
          }
        </span>
      </div>

      {/* Command preview */}
      {preview && (
        <div className="rounded-lg bg-muted px-3 py-2">
          <code className="text-xs text-muted-foreground break-all">{preview}</code>
        </div>
      )}

      {/* Rule preview when "always" option is selected */}
      {rulePreview && (selectedIndex === 1 || selectedIndex === 2) && (
        <div className="rounded-lg bg-muted px-3 py-1.5">
          <span className="text-xs text-muted-foreground">Rule: </span>
          <code className="text-xs text-amber-500">{rulePreview}</code>
        </div>
      )}

      {/* Options */}
      <div className="space-y-1">
        {APPROVAL_OPTIONS.map((option, i) => (
          <button
            key={option}
            type="button"
            onClick={() => { setSelectedIndex(i); }}
            onDoubleClick={handleSubmit}
            className={`
              flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors
              ${i === selectedIndex
                ? 'bg-muted/80 text-foreground'
                : 'text-muted-foreground hover:bg-muted/40'
              }
            `}
          >
            <span className="text-muted-foreground/60 text-xs tabular-nums">{i + 1}.</span>
            <span className={i === selectedIndex ? 'font-medium' : ''}>{option}</span>
            {i === selectedIndex && (
              <span className="ml-auto flex items-center gap-1 text-muted-foreground/50">
                <ChevronUp className="size-3" />
                <ChevronDownIcon className="size-3" />
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={() => approvals.forEach(a => onDecision(a.approvalId, 'denied'))}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background hover:opacity-90 transition-opacity"
        >
          Submit
          <CornerDownLeft className="size-3" />
        </button>
      </div>
    </div>
  )
}
