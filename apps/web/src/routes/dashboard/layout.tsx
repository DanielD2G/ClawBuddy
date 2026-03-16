import { Outlet } from 'react-router-dom'
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { Header } from '@/components/layout/header'

export function DashboardLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <Header />
        <main className="flex flex-1 flex-col overflow-auto p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
