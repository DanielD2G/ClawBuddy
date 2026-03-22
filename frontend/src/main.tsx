import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryProvider } from '@/providers/query-provider'
import { ThemeProvider } from '@/providers/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceProvider } from '@/providers/workspace-provider'
import { Toaster } from '@/components/ui/sonner'
import { App } from '@/App'
import '@/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryProvider>
        <ThemeProvider>
          <TooltipProvider>
            <WorkspaceProvider>
              <App />
              <Toaster />
            </WorkspaceProvider>
          </TooltipProvider>
        </ThemeProvider>
      </QueryProvider>
    </BrowserRouter>
  </StrictMode>,
)
