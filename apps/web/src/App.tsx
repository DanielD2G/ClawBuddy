import { Routes, Route, Navigate } from 'react-router-dom'
import { ProtectedRoute } from '@/components/layout/protected-route'
import { DashboardLayout } from '@/routes/dashboard/layout'
import { DashboardPage } from '@/routes/dashboard/index'
import { WorkspacesPage } from '@/routes/workspaces/index'
import { WorkspacePage } from '@/routes/workspaces/workspace'
import { DocumentPage } from '@/routes/documents/document'
import { ChatPage } from '@/routes/chat/chat'
import { SetupPage } from '@/routes/setup/setup'
import { SettingsLayout } from '@/routes/settings/layout'
import { GeneralSettingsPage } from '@/routes/settings/general'
import { CapabilitiesSettingsPage } from '@/routes/settings/capabilities'
import { CronSettingsPage } from '@/routes/settings/cron'
import { DataSettingsPage } from '@/routes/settings/data'
import { BrowserSettingsPage } from '@/routes/settings/browser'
import { ChannelsSettingsPage } from '@/routes/settings/channels'
import { UpdatePage } from '@/routes/update/update'

export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/update" element={<UpdatePage />} />
        <Route path="/" element={<DashboardLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
          <Route path="workspaces/:id" element={<WorkspacePage />} />
          <Route path="workspaces/:id/documents/:docId" element={<DocumentPage />} />
          <Route path="workspaces/:id/chat" element={<Navigate to="/" replace />} />
          <Route path="chat/:sessionId" element={<ChatPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<GeneralSettingsPage />} />
            <Route path="capabilities" element={<CapabilitiesSettingsPage />} />
            <Route path="cron" element={<CronSettingsPage />} />
            <Route path="data" element={<DataSettingsPage />} />
            <Route path="browser" element={<BrowserSettingsPage />} />
            <Route path="channels" element={<ChannelsSettingsPage />} />
          </Route>
        </Route>
      </Route>

      {/* Redirect legacy routes */}
      <Route path="/dashboard/*" element={<Navigate to="/" replace />} />
      <Route path="/admin" element={<Navigate to="/settings" replace />} />
      <Route path="/admin/*" element={<Navigate to="/settings" replace />} />
    </Routes>
  )
}
