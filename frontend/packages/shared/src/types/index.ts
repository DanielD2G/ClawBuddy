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

export interface User {
  id: string
  name: string
  email: string
  image?: string | null
  createdAt: Date
  updatedAt: Date
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
  processingStep?: string | null
  processingPct?: number | null
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
  workspaceId?: string | null
  title?: string | null
  folderScope: string[]
  agentStatus: string
  lastMessageAt: Date
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

export * from './workspace-settings.js'
