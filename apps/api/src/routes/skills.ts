import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { skillService } from '../services/skill.service.js'
import { imageBuilderService } from '../services/image-builder.service.js'
import { sandboxService } from '../services/sandbox.service.js'
import { logger } from '../lib/logger.js'
import { parseSkillSource } from '../capabilities/skill-parser.js'

const app = new Hono()

/**
 * Upload a skill source file. If it has an installation script, the endpoint
 * streams build logs via SSE so the frontend can show progress.
 */
app.post('/skills/upload', async (c) => {
  const body = await c.req.json()
  const content = typeof body?.content === 'string' ? body.content : null
  const fileName = typeof body?.filename === 'string' ? body.filename : undefined

  if (!content) {
    return c.json({ success: false, error: 'Skill content is required' }, 400)
  }

  // Check if the skill has an installation script to determine response type
  let hasInstallation = false
  try {
    hasInstallation = !!parseSkillSource(content).skill.installation
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid skill data'
    return c.json({ success: false, error: message }, 400)
  }

  if (hasInstallation) {
    // Stream build logs via SSE
    return streamSSE(c, async (stream) => {
      const result = await skillService.uploadSkill(content, {
        fileName,
        onBuildLog: (line) => {
          stream.writeSSE({ event: 'build_log', data: line })
        },
      })

      if (result.success) {
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({ success: true, slug: result.slug }),
        })
      } else {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            success: false,
            error: result.error,
            logs: result.logs,
          }),
        })
      }
    })
  }

  // No installation script — simple JSON response
  const result = await skillService.uploadSkill(content, { fileName })
  if (!result.success) {
    return c.json({ success: false, error: result.error, logs: result.logs }, 400)
  }
  return c.json({ success: true, data: { slug: result.slug } }, 201)
})

/**
 * List all installed skills.
 */
app.get('/skills', async (c) => {
  const skills = await skillService.listSkills()
  return c.json({ success: true, data: skills })
})

/**
 * Delete a skill.
 */
app.delete('/skills/:slug', async (c) => {
  const { slug } = c.req.param()
  const result = await skillService.deleteSkill(slug)
  if (!result.success) {
    return c.json({ success: false, error: result.error }, 400)
  }
  return c.json({ success: true, data: { deleted: true } })
})

/**
 * Force rebuild the skill Docker image for a workspace.
 */
app.post('/skills/rebuild-image', async (c) => {
  const { workspaceId, clearCache } = await c.req.json()
  if (!workspaceId) {
    return c.json({ success: false, error: 'workspaceId is required' }, 400)
  }

  return streamSSE(c, async (stream) => {
    try {
      if (clearCache) {
        await imageBuilderService.invalidateImages()
        await stream.writeSSE({ event: 'build_log', data: 'Cleared cached images' })
      } else {
        await stream.writeSSE({
          event: 'build_log',
          data: 'Reusing cached layers when available...',
        })
      }

      const tag = await imageBuilderService.getOrBuildImage(workspaceId, (line) => {
        stream.writeSSE({ event: 'build_log', data: line })
      })

      // Stop the running container so the next execution uses the new image
      await stream.writeSSE({ event: 'build_log', data: 'Stopping workspace container...' })
      await sandboxService.stopWorkspaceContainer(workspaceId).catch((err) =>
        logger.warn('[Skills] Failed to stop workspace container after build', {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )

      await stream.writeSSE({
        event: 'complete',
        data: JSON.stringify({ success: true, image: tag }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rebuild image'
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ success: false, error: message }),
      })
    }
  })
})

export default app
