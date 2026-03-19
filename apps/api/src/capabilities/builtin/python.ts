import type { CapabilityDefinition } from '../types.js'

export const python: CapabilityDefinition = {
  slug: 'python',
  name: 'Python',
  description: 'Execute Python code in a sandboxed environment with Python 3.12.',
  icon: 'Code',
  category: 'languages',
  version: '1.0.0',
  tools: [
    {
      name: 'run_python',
      description: 'Execute Python code in the sandbox. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The Python code to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (default: 30, max: 300)',
          },
        },
        required: ['code'],
      },
    },
  ],
  systemPrompt:
    'You can execute Python 3.12 code in a sandboxed environment. Use this for data analysis, scripting, calculations, and any Python-based tasks.',
  sandbox: {
    dockerImage: 'clawbuddy-sandbox-full',
    packages: ['python3', 'python3-pip'],
  },
}
