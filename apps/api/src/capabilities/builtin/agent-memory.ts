import type { CapabilityDefinition } from '../types.js'

export const agentMemory: CapabilityDefinition = {
  slug: 'agent-memory',
  name: 'Agent Memory & Files',
  description:
    'Allows the agent to save documents to its knowledge base for future reference, and generate downloadable files for the user.',
  icon: 'FileSearch',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'save_document',
      description:
        'Save a document to the knowledge base for future reference. Use this to store important information, notes, summaries, or any content that should be searchable in future conversations.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Document title',
          },
          content: {
            type: 'string',
            description: 'Document content (markdown or plain text)',
          },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'generate_file',
      description:
        'Generate a downloadable text file and send it to the user. For small content (<2KB), pass content directly. For large content, write it to a sandbox file first and pass sourcePath instead.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'File name with extension (e.g. "report.csv", "summary.md", "data.txt")',
          },
          content: {
            type: 'string',
            description: 'File content (use only for small files <2KB)',
          },
          sourcePath: {
            type: 'string',
            description: 'Path to a sandbox file to use as content (e.g. /workspace/.outputs/abc.txt or $HOME/report.md). Use this instead of content for large files.',
          },
        },
        required: ['filename'],
      },
    },
  ],
  systemPrompt:
    'You have a persistent knowledge base. Use `save_document` to store important information, notes, or summaries that should be searchable in future conversations — this is your memory. Use `generate_file` to create downloadable files (.csv, .md, .txt, .json, etc.) when the user asks for exportable content. For temporary files or sandbox operations, use Bash instead.',
  sandbox: {
    networkAccess: false,
  },
}
