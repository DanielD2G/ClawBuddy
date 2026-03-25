import { Routes, Route, Navigate } from 'react-router-dom'
import { SetupRoute } from '@/components/layout/setup-route'
import { DashboardLayout } from '@/routes/dashboard/layout'
import { DashboardPage } from '@/routes/dashboard/index'
import { WorkspacesPage } from '@/routes/workspaces/index'
import { WorkspacePage } from '@/routes/workspaces/workspace'
import { DocumentPage } from '@/routes/documents/document'
import { ChatPage } from '@/routes/chat/chat'
import { SetupPage } from '@/routes/setup/setup'
import { SettingsLayout } from '@/routes/settings/layout'
import { WorkspaceGeneralSettingsPage } from '@/routes/settings/workspace-general'
import { GlobalGeneralSettingsPage } from '@/routes/settings/general'
import { CapabilitiesSettingsPage } from '@/routes/settings/capabilities'
import { DataCronPage } from '@/routes/settings/cron'
import { DataOverviewPage } from '@/routes/settings/data'
import { BrowserSettingsPage } from '@/routes/settings/browser'
import { ChannelsSettingsPage } from '@/routes/settings/channels'
import { UpdatePage } from '@/routes/update/update'
import { DashboardListPage } from '@/routes/dashboards/index'
import { DashboardViewPage } from '@/routes/dashboards/view'

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />

      <Route element={<SetupRoute />}>
        <Route path="/update" element={<UpdatePage />} />
        <Route path="/" element={<DashboardLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="dashboards" element={<DashboardListPage />} />
          <Route path="dashboards/:id" element={<DashboardViewPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
          <Route path="workspaces/:id" element={<WorkspacePage />} />
          <Route path="workspaces/:id/documents/:docId" element={<DocumentPage />} />
          <Route path="workspaces/:id/chat" element={<Navigate to="/" replace />} />
          <Route path="chat/:sessionId" element={<ChatPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="workspace/general" replace />} />
            <Route path="workspace/general" element={<WorkspaceGeneralSettingsPage />} />
            <Route path="workspace/capabilities" element={<CapabilitiesSettingsPage />} />
            <Route path="workspace/channels" element={<ChannelsSettingsPage />} />
            <Route path="globals/general" element={<GlobalGeneralSettingsPage />} />
            <Route path="globals/browser" element={<BrowserSettingsPage />} />
            <Route path="data/overview" element={<DataOverviewPage />} />
            <Route path="data/cron" element={<DataCronPage />} />

            <Route path="general" element={<Navigate to="/settings/globals/general" replace />} />
            <Route
              path="capabilities"
              element={<Navigate to="/settings/workspace/capabilities" replace />}
            />
            <Route
              path="channels"
              element={<Navigate to="/settings/workspace/channels" replace />}
            />
            <Route path="browser" element={<Navigate to="/settings/globals/browser" replace />} />
            <Route path="data" element={<Navigate to="/settings/data/overview" replace />} />
            <Route path="cron" element={<Navigate to="/settings/data/cron" replace />} />
          </Route>
        </Route>
      </Route>

      {/* Redirect legacy routes */}
      <Route path="/dashboard/*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
