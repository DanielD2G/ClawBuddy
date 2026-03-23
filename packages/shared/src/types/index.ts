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

export * from './workspace-settings.js'
