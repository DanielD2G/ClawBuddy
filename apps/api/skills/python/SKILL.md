---
name: python
description: Execute Python code in a sandboxed environment with Python 3.
compatibility: opencode
clawbuddy:
  displayName: Python
  version: 1.0.0
  icon: Code
  category: languages
  type: python
  networkAccess: false
  installation: apt-get update && apt-get install -y --no-install-recommends
    python3-venv && rm -rf /var/lib/apt/lists/*
  tools:
    - name: run_python
      description: Execute Python code in the sandbox. Returns stdout, stderr, and
        exit code.
      parameters:
        type: object
        properties:
          code:
            type: string
            description: The Python code to execute
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required:
          - code
---

You can execute Python 3 code in a sandboxed environment. Use this for data analysis, scripting, calculations, and any Python-based tasks.
