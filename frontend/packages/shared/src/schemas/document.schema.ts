import { z } from 'zod'
import { DocumentType } from '../types/index.js'

export const createDocumentSchema = z.object({
  title: z.string().min(1, 'Document title is required').max(200),
  folderId: z.string().uuid().optional(),
  type: z.nativeEnum(DocumentType),
  content: z.string().optional(),
})

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>
