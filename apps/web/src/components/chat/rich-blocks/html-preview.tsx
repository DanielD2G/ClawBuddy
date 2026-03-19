import { useState, useEffect, useRef, useCallback } from 'react'
import { Code, Maximize2, Minimize2, ExternalLink } from 'lucide-react'

interface HtmlPreviewProps {
  html: string
}

const RESIZE_SCRIPT = `<script>
(function(){
  var ro = new ResizeObserver(function(){
    parent.postMessage({type:'rich-html-resize',height:document.documentElement.scrollHeight},'*');
  });
  ro.observe(document.documentElement);
})();
</script>`

function injectResizeScript(html: string): string {
  if (html.includes('</body>')) {
    return html.replace('</body>', RESIZE_SCRIPT + '</body>')
  }
  if (html.includes('</html>')) {
    return html.replace('</html>', RESIZE_SCRIPT + '</html>')
  }
  return html + RESIZE_SCRIPT
}

export function HtmlPreview({ html }: HtmlPreviewProps) {
  const [expanded, setExpanded] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [height, setHeight] = useState(300)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const srcdoc = injectResizeScript(html)

  const handleMessage = useCallback((e: MessageEvent) => {
    if (e.data?.type === 'rich-html-resize' && typeof e.data.height === 'number') {
      if (e.source === iframeRef.current?.contentWindow) {
        setHeight(Math.min(Math.max(e.data.height + 16, 100), expanded ? 2000 : 600))
      }
    }
  }, [expanded])

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  const openInNewTab = () => {
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Code className="size-3.5" />
          HTML Preview
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowCode(!showCode)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title={showCode ? 'Hide code' : 'Show code'}
          >
            <Code className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={openInNewTab}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Open in new tab"
          >
            <ExternalLink className="size-3.5" />
          </button>
        </div>
      </div>

      {showCode && (
        <pre className="max-h-60 overflow-auto border-b border-border bg-muted/10 p-3 text-xs">
          <code>{html}</code>
        </pre>
      )}

      <iframe
        ref={iframeRef}
        title="HTML Preview"
        srcDoc={srcdoc}
        sandbox="allow-scripts"
        className="w-full border-0 bg-white"
        style={{ height }}
      />
    </div>
  )
}
