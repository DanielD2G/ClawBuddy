import { useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useFolders, useCreateFolder, useDeleteFolder } from '@/hooks/use-folders'
import { useDocuments, useUploadDocument, useDeleteDocument, useMoveDocument, useReingestDocument } from '@/hooks/use-documents'
import { ExplorerBreadcrumb } from './explorer-breadcrumb'
import { ExplorerItemList } from './explorer-item-list'
import { DropZone } from './drop-zone'
import { AddItemModal } from './add-item-modal'

interface FileExplorerProps {
  workspaceId: string
  workspaceName: string
}

export function FileExplorer({ workspaceId, workspaceName }: FileExplorerProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const currentFolderId = searchParams.get('folder') || null
  const [modalOpen, setModalOpen] = useState(false)

  const { data: folders = [], isLoading: foldersLoading } = useFolders(workspaceId, currentFolderId)
  const { data: documents = [], isLoading: docsLoading } = useDocuments(workspaceId, currentFolderId ?? 'null')

  const createFolder = useCreateFolder(workspaceId)
  const deleteFolder = useDeleteFolder(workspaceId)
  const upload = useUploadDocument(workspaceId)
  const deleteDoc = useDeleteDocument(workspaceId)
  const moveDoc = useMoveDocument(workspaceId)
  const reingestDoc = useReingestDocument(workspaceId)

  const navigateTo = useCallback(
    (folderId: string | null) => {
      if (folderId) {
        setSearchParams({ folder: folderId })
      } else {
        setSearchParams({})
      }
    },
    [setSearchParams],
  )

  const handleDrop = useCallback(
    async (files: FileList) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const formData = new FormData()
        formData.append('file', file)
        try {
          await upload.mutateAsync({ formData, folderId: currentFolderId })
          toast.success(`"${file.name}" uploaded`)
        } catch {
          toast.error(`Failed to upload "${file.name}"`)
        }
      }
    },
    [upload, currentFolderId],
  )

  const handleCreateFolder = async (name: string) => {
    await createFolder.mutateAsync({ name, parentId: currentFolderId })
    toast.success(`Folder "${name}" created`)
  }

  const handleUploadFile = async (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    await upload.mutateAsync({ formData, folderId: currentFolderId })
    toast.success(`"${file.name}" uploaded`)
  }

  const handleDeleteFolder = async (folderId: string) => {
    await deleteFolder.mutateAsync(folderId)
    toast.success('Folder deleted')
  }

  const handleDeleteDocument = async (docId: string) => {
    await deleteDoc.mutateAsync(docId)
    toast.success('Document deleted')
  }

  const handleReingestDocument = async (docId: string) => {
    try {
      await reingestDoc.mutateAsync(docId)
      toast.success('Retrying ingestion...')
    } catch {
      toast.error('Failed to retry ingestion')
    }
  }

  const handleDropFilesToFolder = useCallback(
    async (folderId: string, files: FileList) => {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const formData = new FormData()
        formData.append('file', file)
        try {
          await upload.mutateAsync({ formData, folderId })
          toast.success(`"${file.name}" uploaded to folder`)
        } catch {
          toast.error(`Failed to upload "${file.name}"`)
        }
      }
    },
    [upload],
  )

  const handleMoveDocToFolder = useCallback(
    async (docId: string, folderId: string) => {
      try {
        await moveDoc.mutateAsync({ docId, folderId })
        toast.success('File moved to folder')
      } catch {
        toast.error('Failed to move file')
      }
    },
    [moveDoc],
  )

  return (
    <DropZone onDrop={handleDrop} className="min-h-[300px]">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <ExplorerBreadcrumb
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            currentFolderId={currentFolderId}
            onNavigate={navigateTo}
          />
          <Button variant="outline" size="sm" onClick={() => setModalOpen(true)}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        </div>

        <ExplorerItemList
          folders={folders}
          documents={documents}
          isLoading={foldersLoading || docsLoading}
          onFolderClick={navigateTo}
          onDeleteFolder={handleDeleteFolder}
          onDeleteDocument={handleDeleteDocument}
          onReingestDocument={handleReingestDocument}
          onDocumentClick={(docId) => navigate(`/workspaces/${workspaceId}/documents/${docId}`)}
          onDropFilesToFolder={handleDropFilesToFolder}
          onMoveDocToFolder={handleMoveDocToFolder}
          onAddClick={() => setModalOpen(true)}
        />
      </div>

      <AddItemModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onCreateFolder={handleCreateFolder}
        onUploadFile={handleUploadFile}
      />
    </DropZone>
  )
}
