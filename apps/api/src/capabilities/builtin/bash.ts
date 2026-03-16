import type { CapabilityDefinition } from '../types.js'

export const bash: CapabilityDefinition = {
  slug: 'bash',
  name: 'Bash Shell',
  description: 'Execute bash commands in a sandboxed environment.',
  icon: 'Terminal',
  category: 'general',
  version: '1.0.0',
  tools: [
    {
      name: 'run_bash',
      description:
        'Execute a bash command in the sandbox. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          workingDir: {
            type: 'string',
            description: 'Working directory for the command (default: /workspace)',
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
    'You can execute bash commands in a sandboxed Linux environment. The working directory is /workspace. Use this to run shell commands, manipulate files, and perform system operations.',
  sandbox: {
    dockerImage: 'agentbuddy-sandbox-full',
    packages: ['curl', 'wget', 'jq', 'git'],
  },
}
