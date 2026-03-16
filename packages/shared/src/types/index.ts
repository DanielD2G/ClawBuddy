export enum DocumentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  READY = 'READY',
  FAILED = 'FAILED',
}

export enum DocumentType {
  MARKDOWN = 'MARKDOWN',
  PDF = 'PDF',
  DOCX = 'DOCX',
  TXT = 'TXT',
  HTML = 'HTML',
}

export enum WorkspaceRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export interface User {
  id: string
  name: string
  email: string
  image?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Workspace {
  id: string
  name: string
  description?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface WorkspaceMember {
  id: string
  workspaceId: string
  userId: string
  role: WorkspaceRole
  createdAt: Date
}

export interface Folder {
  id: string
  name: string
  workspaceId: string
  parentId?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface Document {
  id: string
  title: string
  workspaceId: string
  folderId?: string | null
  status: DocumentStatus
  type: DocumentType
  fileUrl?: string | null
  content?: string | null
  chunkCount: number
  createdAt: Date
  updatedAt: Date
}

export interface DocumentChunk {
  id: string
  documentId: string
  content: string
  qdrantId: string
  chunkIndex: number
  metadata?: Record<string, unknown>
}

export interface ChatSession {
  id: string
  workspaceId: string
  userId: string
  title?: string | null
  folderScope: string[]
  createdAt: Date
  updatedAt: Date
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  sources?: DocumentChunk[]
  createdAt: Date
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}
