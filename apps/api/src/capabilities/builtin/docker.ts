import type { CapabilityDefinition } from '../types.js'

export const docker: CapabilityDefinition = {
  slug: 'docker',
  name: 'Docker',
  description: 'Execute Docker commands to manage containers and images.',
  icon: 'Box',
  category: 'devops',
  version: '1.0.0',
  tools: [
    {
      name: 'docker_command',
      description:
        'Execute a Docker command. The command should NOT include the "docker" prefix.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The Docker command (without the "docker" prefix), e.g. "ps" or "images"',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (default: 30, max: 300)',
          },
        },
        required: ['command'],
      },
    },
  ],
  systemPrompt:
    'You can execute Docker commands to manage containers and images in the sandbox environment.',
  configSchema: [
    { key: 'dockerHost', label: 'Docker Host', type: 'string', required: false, envVar: 'DOCKER_HOST', default: 'unix:///var/run/docker.sock' },
  ],
  sandbox: {
    dockerImage: 'agentbuddy-sandbox-full',
    networkAccess: true,
  },
}
