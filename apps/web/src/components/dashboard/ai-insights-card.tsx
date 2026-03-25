import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { SourcesFooter, type Source } from './sources-footer'

interface AiInsightsCardProps {
  title?: string | null
  lastInsight: string | null
  lastInsightAt: string | null
  prompt: string | null
  sources?: Source[]
}

export function AiInsightsCard({ title, lastInsight, lastInsightAt, sources }: AiInsightsCardProps) {
  return (
    <Card className="h-full flex flex-col py-5 md:py-6">
      <CardHeader className="px-5 md:px-6">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="size-5 text-brand" />
          {title ?? 'AI Insights'}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 md:px-6">
        {lastInsight ? (
          <div className="prose prose-base dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{lastInsight}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Insights will appear here after the first dashboard refresh.
          </p>
        )}
        <SourcesFooter sources={sources} />
      </CardContent>
      {lastInsightAt && (
        <CardFooter>
          <p className="text-sm text-muted-foreground">
            Last updated:{' '}
            {new Date(lastInsightAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </p>
        </CardFooter>
      )}
    </Card>
  )
}
