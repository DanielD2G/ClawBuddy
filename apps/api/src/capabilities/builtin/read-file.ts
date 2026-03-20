import type { CapabilityDefinition } from '../types.js'

export const readFile: CapabilityDefinition = {
  slug: 'read-file',
  name: 'Read File',
  description: 'Read files from the workspace with line numbers, pagination, and binary detection.',
  icon: 'FileText',
  category: 'builtin',
  version: '1.0.0',
  tools: [
    {
      name: 'read_file',
      description:
        'Read a file from the workspace. Returns content with line numbers (cat -n format). Supports pagination via offset/limit for large files. Automatically detects and rejects binary files.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'Path to the file to read. Relative paths resolve from your working directory.',
          },
          offset: {
            type: 'number',
            description: 'Line number to start from (1-based). Defaults to 1.',
          },
          limit: {
            type: 'number',
            description: 'Number of lines to read. Defaults to 2000. Maximum 2000.',
          },
        },
        required: ['file_path'],
      },
    },
  ],
  systemPrompt: `You have access to read_file for reading file contents directly with line numbers and pagination.

**When to use read_file:**
- Reading source code, config files, logs, or any text file
- When you need line numbers for precise reference
- When you need to read a specific section of a large file (use offset/limit)

**When NOT to use read_file:**
- For searching across files (use bash with grep instead)
- For listing directory contents (use bash with ls)
- For reading uploaded documents from the knowledge base (use search_documents)

read_file returns content in "cat -n" format with line numbers. Lines longer than 2000 characters are truncated. For files larger than 2000 lines, use offset and limit to paginate.`,
  sandbox: {},
}
