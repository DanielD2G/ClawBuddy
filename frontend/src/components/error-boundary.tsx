import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
  retryCount: number
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, retryCount: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex flex-col items-center justify-center min-h-[200px] p-8 text-center">
            <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
            <p className="text-muted-foreground mb-4">{this.state.error?.message}</p>
            {this.state.retryCount >= 2 ? (
              <button
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md"
                onClick={() => window.location.reload()}
              >
                Reload page
              </button>
            ) : (
              <button
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md"
                onClick={() =>
                  this.setState((s) => ({
                    hasError: false,
                    error: undefined,
                    retryCount: s.retryCount + 1,
                  }))
                }
              >
                Try again
              </button>
            )}
          </div>
        )
      )
    }
    return this.props.children
  }
}
