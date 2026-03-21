import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { hasAvailableUpdate, useUpdateOverview } from '@/hooks/use-update'

const UPDATE_TOAST_ID = 'clawbuddy-update-available'

export function UpdateNotifier() {
  const navigate = useNavigate()
  const location = useLocation()
  const { data } = useUpdateOverview()

  useEffect(() => {
    if (location.pathname.startsWith('/update')) {
      toast.dismiss(UPDATE_TOAST_ID)
      return
    }

    if (!hasAvailableUpdate(data) || !data?.latestRelease) {
      toast.dismiss(UPDATE_TOAST_ID)
      return
    }

    toast.info(`ClawBuddy ${data.latestRelease.version} is available`, {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      description: data.latestRelease.name,
      action: {
        label: 'Review',
        onClick: () => navigate('/update'),
      },
      cancel: {
        label: 'Later',
        onClick: () => toast.dismiss(UPDATE_TOAST_ID),
      },
    })
  }, [data, location.pathname, navigate])

  return null
}
