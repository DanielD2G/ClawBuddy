import { useParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function FolderPage() {
  const { folderId } = useParams<{ folderId: string }>()
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Folder</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Folder {folderId}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Documents in this folder will appear here.</p>
        </CardContent>
      </Card>
    </div>
  )
}
