import { useState, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { FolderPlus, Upload } from 'lucide-react'

interface AddItemModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateFolder: (name: string) => Promise<void>
  onUploadFile: (file: File) => Promise<void>
}

export function AddItemModal({
  open,
  onOpenChange,
  onCreateFolder,
  onUploadFile,
}: AddItemModalProps) {
  const [folderName, setFolderName] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleCreateFolder = async () => {
    if (!folderName.trim()) return
    setCreating(true)
    try {
      await onCreateFolder(folderName.trim())
      setFolderName('')
      onOpenChange(false)
    } finally {
      setCreating(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      await onUploadFile(file)
      onOpenChange(false)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to folder</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="folder">
          <TabsList className="w-full">
            <TabsTrigger value="folder" className="flex-1">
              <FolderPlus data-icon="inline-start" />
              New Folder
            </TabsTrigger>
            <TabsTrigger value="upload" className="flex-1">
              <Upload data-icon="inline-start" />
              Upload File
            </TabsTrigger>
          </TabsList>
          <TabsContent value="folder" className="mt-4">
            <div className="flex flex-col gap-3">
              <Input
                placeholder="Folder name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                autoFocus
              />
              <Button onClick={handleCreateFolder} disabled={!folderName.trim() || creating}>
                {creating && <Spinner data-icon="inline-start" />}
                Create Folder
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="upload" className="mt-4">
            <div className="flex flex-col gap-3">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.docx,.md,.txt,.html"
                onChange={handleFileChange}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="h-24 border-dashed"
              >
                {uploading ? (
                  <Spinner className="size-6" />
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <Upload className="size-6 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Click to select a file</span>
                  </div>
                )}
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Supported: PDF, DOCX, MD, TXT, HTML
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
