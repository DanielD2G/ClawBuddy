import { Outlet } from 'react-router-dom'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { Header } from '@/components/layout/header'
import { ErrorBoundary } from '@/components/error-boundary'
import { UpdateNotifier } from '@/components/update/update-notifier'

export function DashboardLayout() {
  return (
    <SidebarProvider>
      <UpdateNotifier />
      <AppSidebar />
      <SidebarInset>
        <Header />
        <main className="relative flex flex-1 flex-col overflow-auto px-6 pb-6 pt-14">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
