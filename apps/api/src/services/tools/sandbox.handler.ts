import type { ToolCall } from '../../providers/llm.interface.js'
import { sandboxService } from '../sandbox.service.js'
import { stripNullBytes } from '../../lib/sanitize.js'
import type { ExecutionContext, ExecutionResult } from './handler-utils.js'

/**
 * Resolve a dynamic skill tool name to a shell command.
 * Uses the capability's skillType to determine how to execute.
 */
async function resolveSkillCommand(
  toolName: string,
  args: Record<string, unknown>,
  capabilitySlug: string,
  preloadedCapability?: { skillType: string | null; toolDefinitions: unknown },
): Promise<string> {
  // Use pre-loaded capability data when available to avoid redundant DB queries
  let skillType: string | null = null
  let toolDefinitions: unknown = null

  if (preloadedCapability) {
    skillType = preloadedCapability.skillType
    toolDefinitions = preloadedCapability.toolDefinitions
  } else {
    const { prisma: db } = await import('../../lib/prisma.js')
    const capability = await db.capability.findUnique({
      where: { slug: capabilitySlug },
    })
    skillType = capability?.skillType ?? null
    toolDefinitions = capability?.toolDefinitions ?? null
  }

  if (!skillType) return ''

  // Look up the tool definition to check for prefix/script
  const toolDefs = toolDefinitions as Array<{
    name: string
    prefix?: string
    script?: string
    parameters?: { required?: string[] }
  }>
  const toolDef = toolDefs?.find((t) => t.name === toolName)
  const prefix = toolDef?.prefix ?? ''

  // If the tool has a script, write it to a file and execute with args as CLI arguments
  if (toolDef?.script) {
    const ext = skillType === 'python' ? 'py' : skillType === 'js' ? 'mjs' : 'sh'
    const runtime = skillType === 'python' ? 'python3' : skillType === 'js' ? 'node' : 'bash'
    const scriptPath = `/tmp/_skill_${toolName}.${ext}`

    // Collect tool arguments as positional CLI args in a stable order (required first)
    const paramDef = toolDef.parameters as { required?: string[] } | undefined
    const requiredKeys = paramDef?.required ?? []
    const orderedKeys = [
      ...requiredKeys,
      ...Object.keys(args).filter((k) => !requiredKeys.includes(k) && k !== 'timeout'),
    ]
    const cliArgs = orderedKeys
      .map((k) => args[k])
      .filter((v) => v !== undefined && v !== null)
      .map((v) => JSON.stringify(String(v)))
      .join(' ')

    const writeCmd = `cat > ${scriptPath} << 'SKILL_SCRIPT_EOF'\n${toolDef.script}\nSKILL_SCRIPT_EOF`
    return `${writeCmd}\n${runtime} ${scriptPath} ${cliArgs}`
  }

  // Determine command based on skill type and tool arguments
  switch (skillType) {
    case 'bash': {
      const raw = (args.command ?? args.code ?? '') as string
      return prefix ? `${prefix} ${raw}` : raw
    }
    case 'python': {
      const code = (args.code ?? args.command ?? '') as string
      const pyB64 = Buffer.from(code).toString('base64')
      return `echo '${pyB64}' | base64 -d | python3`
    }
    case 'js': {
      const code = (args.code ?? args.command ?? '') as string
      const jsB64 = Buffer.from(code).toString('base64')
      return `echo '${jsB64}' | base64 -d | node`
    }
    default:
      return ''
  }
}

/**
 * Execute a command in the sandbox.
 * Handles both hardcoded tools (file-ops) and dynamic skill tools.
 */
export async function executeSandboxCommand(
  toolCall: ToolCall,
  capabilitySlug: string,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  const startTime = Date.now()

  if (!context.workspaceId) {
    return {
      output: '',
      error: 'No workspace context available. Sandbox capabilities require a workspace.',
      durationMs: Date.now() - startTime,
    }
  }

  const args = toolCall.arguments as Record<string, unknown>
  let command: string

  switch (toolCall.name) {
    // Well-known runtime tools
    case 'run_bash':
      command = args.command as string
      break
    case 'run_python': {
      const pyB64 = Buffer.from(args.code as string).toString('base64')
      command = `echo '${pyB64}' | base64 -d | python3`
      break
    }
    case 'run_js': {
      const jsB64 = Buffer.from(args.code as string).toString('base64')
      command = `echo '${jsB64}' | base64 -d | node`
      break
    }

    default: {
      // Dynamic skill tool resolution:
      // Use pre-loaded capability data when available to avoid redundant DB queries
      command = await resolveSkillCommand(toolCall.name, args, capabilitySlug, context.capability)
      if (!command) {
        return {
          output: '',
          error: `Unsupported sandbox tool: ${toolCall.name}`,
          durationMs: Date.now() - startTime,
        }
      }
      break
    }
  }

  const userHome = '/workspace'
  const execOptions = {
    timeout: (args.timeout as number) ?? 30,
    workingDir: (args.workingDir as string) ?? userHome,
  }

  const result = await sandboxService.execInWorkspace(context.workspaceId, command, execOptions)

  // Sanitize output to strip null bytes that break PostgreSQL and JSON
  const stdout = result.stdout ? stripNullBytes(result.stdout) : ''
  const stderr = result.stderr ? stripNullBytes(result.stderr) : ''

  const output = [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
    `exit code: ${result.exitCode}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    output,
    error:
      result.exitCode !== 0
        ? stderr || `Command failed with exit code ${result.exitCode}`
        : undefined,
    exitCode: result.exitCode,
    durationMs: Date.now() - startTime,
  }
}
