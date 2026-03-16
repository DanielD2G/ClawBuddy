import { useState, useRef, useCallback, type ReactNode, type DragEvent } from 'react'
import { Upload } from 'lucide-react'

interface DropZoneProps {
  onDrop: (files: FileList) => void
  children: ReactNode
  className?: string
}

export function DropZone({ onDrop, children, className }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer.types.includes('Files')) {
        setIsDragging(true)
      }
    },
    [],
  )

  const handleDragLeave = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    },
    [],
  )

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      dragCounter.current = 0
      if (e.dataTransfer.files.length > 0) {
        onDrop(e.dataTransfer.files)
      }
    },
    [onDrop],
  )

  return (
    <div
      className={`relative ${className ?? ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/5 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-brand">
            <Upload className="size-10" />
            <p className="text-lg font-medium">Drop files to upload</p>
          </div>
        </div>
      )}
    </div>
  )
}

interface FolderDropTargetProps {
  onFileDrop?: (files: FileList) => void
  onDocumentDrop?: (docId: string) => void
  children: ReactNode
  className?: string
}

export function FolderDropTarget({ onFileDrop, onDocumentDrop, children, className }: FolderDropTargetProps) {
  const [isOver, setIsOver] = useState(false)
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-agentbuddy-doc')) {
      setIsOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setIsOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsOver(false)
      dragCounter.current = 0

      const docId = e.dataTransfer.getData('application/x-agentbuddy-doc')
      if (docId && onDocumentDrop) {
        onDocumentDrop(docId)
        return
      }

      if (e.dataTransfer.files.length > 0 && onFileDrop) {
        onFileDrop(e.dataTransfer.files)
      }
    },
    [onFileDrop, onDocumentDrop],
  )

  return (
    <div
      className={className}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      data-drag-over={isOver || undefined}
    >
      {children}
    </div>
  )
}
