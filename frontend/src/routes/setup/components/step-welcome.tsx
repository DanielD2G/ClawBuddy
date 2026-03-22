import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ChevronRight, Upload } from 'lucide-react'

interface StepWelcomeProps {
  onNext: () => void
  onImport?: (data: Record<string, unknown>) => void
  isImporting?: boolean
}

export function StepWelcome({ onNext, onImport, isImporting }: StepWelcomeProps) {
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !onImport) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      onImport(data)
    } catch {
      // Reset on error
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div>
      <div className="mb-8 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Welcome to ClawBuddy</h2>
        <p className="text-muted-foreground mt-1">
          Let&apos;s configure your instance. This will only take a minute.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>We&apos;ll set up:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Provider connections for your AI backends</li>
            <li>Embedding model for document search</li>
            <li>Chat model for conversations</li>
            <li>Agent capabilities</li>
          </ul>
        </div>
        <div className="flex items-center justify-between mt-8 pt-6 border-t border-border/50">
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              onChange={handleFile}
              className="hidden"
            />
            <Button variant="ghost" onClick={() => fileRef.current?.click()} disabled={isImporting}>
              {isImporting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Upload data-icon="inline-start" />
              )}
              {isImporting ? 'Importing...' : 'Import from file'}
            </Button>
          </div>
          <Button
            onClick={onNext}
            className="bg-brand text-brand-foreground hover:bg-brand/90 h-11 px-8 text-base"
          >
            Get started
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  )
}
