import { Navigate, Outlet } from 'react-router-dom'
import { useSetupStatus } from '@/hooks/use-setup'
import { Spinner } from '@/components/ui/spinner'

export function ProtectedRoute() {
  const { onboardingComplete, isLoading: setupLoading } = useSetupStatus()

  if (setupLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Spinner className="text-brand" />
      </div>
    )
  }

  // If setup not done, redirect to setup
  if (onboardingComplete === false) {
    return <Navigate to="/setup" replace />
  }

  return <Outlet />
}
