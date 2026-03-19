import type { CapabilityDefinition } from '../types.js'

export const kubectl: CapabilityDefinition = {
  slug: 'kubectl',
  name: 'Kubectl',
  description: 'Execute kubectl commands to manage Kubernetes clusters.',
  icon: 'Container',
  category: 'devops',
  version: '1.0.0',
  tools: [
    {
      name: 'kubectl_command',
      description:
        'Execute a kubectl command. The command should NOT include the "kubectl" prefix.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'The kubectl command (without the "kubectl" prefix), e.g. "get pods" or "describe deployment my-app"',
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
    'You can execute kubectl commands to manage Kubernetes clusters. Kubeconfig should be configured in the workspace.',
  configSchema: [
    {
      key: 'kubeconfig',
      label: 'Kubeconfig (base64)',
      type: 'password',
      required: true,
      envVar: 'KUBECONFIG_B64',
      description: 'Base64-encoded kubeconfig content',
    },
    {
      key: 'kubeContext',
      label: 'Context',
      type: 'string',
      required: false,
      envVar: 'KUBE_CONTEXT',
    },
  ],
  sandbox: {
    dockerImage: 'clawbuddy-sandbox-full',
    packages: ['kubectl'],
    networkAccess: true,
  },
}
