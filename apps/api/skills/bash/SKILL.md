---
name: bash
description: Execute bash commands in a sandboxed environment.
compatibility: opencode
clawbuddy:
  displayName: Bash Shell
  version: 1.0.0
  icon: Terminal
  category: general
  type: bash
  networkAccess: false
  installation: apt-get update && apt-get install -y --no-install-recommends curl
    wget jq git && rm -rf /var/lib/apt/lists/*
  tools:
    - name: run_bash
      description: Execute a bash command in the sandbox. Returns stdout, stderr, and
        exit code.
      parameters:
        type: object
        properties:
          command:
            type: string
            description: The bash command to execute
          workingDir:
            type: string
            description: 'Working directory for the command (default: /workspace)'
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required:
          - command
---

You can execute bash commands in a sandboxed Linux environment. The working directory is /workspace. Use this to run shell commands, manipulate files, and perform system operations.

IMPORTANT: Do NOT use cat, head, or tail to read file contents. Use the read_file tool instead — it provides line numbers, pagination, and binary detection. Only use bash for file reading when you need advanced processing (jq, grep, awk, sed) that read_file does not support.
