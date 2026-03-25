import { Hono } from 'hono'
import { fail, ok } from '../lib/responses.js'
import { updateService } from '../services/update.service.js'

const app = new Hono()

app.get('/update', async (c) => {
  return ok(c, await updateService.getOverview())
})

app.get('/update/runs/:id', async (c) => {
  const run = await updateService.getRun(c.req.param('id'))
  if (!run) {
    return fail(c, 'Update run not found', 404)
  }

  return ok(c, run)
})

app.post('/update/check', async (c) => {
  try {
    return ok(c, await updateService.forceCheck())
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : 'Failed to refresh releases', 500)
  }
})

app.post('/update/runs', async (c) => {
  try {
    return ok(c, await updateService.createRunForLatestRelease(), 201)
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : 'Failed to queue update', 409)
  }
})

app.post('/update/runs/:id/retry', async (c) => {
  try {
    return ok(c, await updateService.retryRun(c.req.param('id')))
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : 'Failed to retry update', 409)
  }
})

app.post('/update/accept', async (c) => {
  try {
    return ok(c, await updateService.acceptLatestRelease())
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : 'Failed to start update', 409)
  }
})

app.post('/update/decline', async (c) => {
  try {
    await updateService.declineLatestRelease()
    return ok(c, await updateService.getOverview(true))
  } catch (error) {
    return fail(c, error instanceof Error ? error.message : 'Failed to dismiss release', 500)
  }
})

export default app
