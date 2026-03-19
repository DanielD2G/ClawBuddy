import type { CapabilityDefinition } from '../types.js'

export const cronManagement: CapabilityDefinition = {
  slug: 'cron-management',
  name: 'Cron Management',
  description:
    'Create, list, and delete recurring scheduled tasks (cron jobs). Use this when the user asks for something to happen on a schedule or periodically.',
  icon: 'Clock',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'create_cron',
      description:
        'Create a recurring cron job that executes a prompt on a schedule. Use standard cron expressions (e.g., "*/20 * * * *" for every 20 minutes, "0 9 * * *" for daily at 9am).',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'A short descriptive name for the cron job',
          },
          schedule: {
            type: 'string',
            description: 'Cron expression (e.g., "*/20 * * * *" for every 20 minutes)',
          },
          prompt: {
            type: 'string',
            description: 'The instruction/prompt to execute on each run',
          },
        },
        required: ['name', 'schedule', 'prompt'],
      },
    },
    {
      name: 'list_crons',
      description: 'List all configured cron jobs with their status and schedule.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'delete_cron',
      description: 'Delete a cron job by its ID. Cannot delete built-in system cron jobs.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The ID of the cron job to delete',
          },
        },
        required: ['id'],
      },
    },
  ],
  systemPrompt:
    'You can create scheduled recurring tasks using create_cron. When the user asks for something to happen periodically (e.g., "every 20 minutes check X", "daily at 9am do Y"), use create_cron with an appropriate cron expression and a clear prompt describing what to do. The cron will run in this same conversation — the agent will wake up, execute the task, and write results back here. Use list_crons to show existing schedules and delete_cron to remove them.',
  sandbox: {},
}
