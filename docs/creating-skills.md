# Creating Skills for ClawBuddy

ClawBuddy now uses Markdown skills compatible with the OpenCode `SKILL.md` format.

The OpenCode-compatible fields stay at the top level, and every field that is specific to ClawBuddy lives under `clawbuddy:`.

## File Layout

Use one folder per skill:

```text
apps/api/skills/
  bash/
    SKILL.md
```

The filename must be `SKILL.md`.

## Format

```md
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
  installation: apt-get update && apt-get install -y --no-install-recommends curl wget jq git && rm -rf /var/lib/apt/lists/*
  tools:
    - name: run_bash
      description: Execute a bash command in the sandbox.
      parameters:
        type: object
        properties:
          command:
            type: string
            description: The bash command to execute
        required:
          - command
  inputs:
    workspace:
      type: var
      default: /workspace
---

You can execute bash commands in a sandboxed Linux environment.
Use this skill when the agent needs shell access.
```

The Markdown body becomes the instruction prompt injected into the agent.

## Top-Level Fields

These fields follow the OpenCode format:

| Field           | Required | Notes                                                    |
| --------------- | -------- | -------------------------------------------------------- |
| `name`          | Yes      | Lowercase slug. Use `^[a-z0-9]+(-[a-z0-9]+)*$`.          |
| `description`   | Yes      | Short skill description used for discovery.              |
| `license`       | No       | Optional OpenCode metadata.                              |
| `compatibility` | No       | Optional. We usually set `opencode`.                     |
| `metadata`      | No       | Optional string-to-string metadata map.                  |
| `clawbuddy`     | Yes      | All ClawBuddy-specific runtime configuration lives here. |

## `clawbuddy` Fields

| Field           | Required | Description                                                                  |
| --------------- | -------- | ---------------------------------------------------------------------------- |
| `displayName`   | No       | Human-friendly label shown in the UI. Defaults to a humanized `name`.        |
| `version`       | No       | Semver string. Defaults to `1.0.0`.                                          |
| `icon`          | No       | Lucide icon name.                                                            |
| `category`      | No       | UI grouping label. Defaults to `general`.                                    |
| `type`          | Yes      | Runtime: `bash`, `python`, or `js`.                                          |
| `tag`           | No       | Accepted as a migration alias for `type`, but `type` is the canonical field. |
| `networkAccess` | No       | Enables outbound network access in the sandbox. Defaults to `false`.         |
| `installation`  | No       | Shell commands run during Docker image build.                                |
| `tools`         | Yes      | Tool definitions exposed to the agent. At least one is required.             |
| `inputs`        | No       | Admin-provided config values injected as environment variables.              |

## Tool Definitions

Each entry in `clawbuddy.tools` describes one callable tool.

### Command tool

```yaml
tools:
  - name: aws_command
    description: Execute an AWS CLI command without the aws prefix.
    prefix: aws
    parameters:
      type: object
      properties:
        command:
          type: string
          description: Example: s3 ls
      required:
        - command
```

### Script tool

```yaml
tools:
  - name: ml_search
    description: Search MercadoLibre.
    script: |
      import sys
      query = sys.argv[1]
      print(query)
    parameters:
      type: object
      properties:
        query:
          type: string
      required:
        - query
```

## Inputs

`clawbuddy.inputs` supports the same two formats as before.

Short form:

```yaml
inputs:
  api_key: secret
  region: var
```

Extended form:

```yaml
inputs:
  aws_default_region:
    type: var
    default: us-east-1
    description: AWS region to use
  api_token:
    type: secret
    description: API authentication token
```

## Uploading Skills

From the Settings UI you can upload `SKILL.md`.

## Bundled Skills

Bundled skills are loaded from `apps/api/skills/<slug>/SKILL.md` and synced to object storage on startup.

## Installation Scripts

`clawbuddy.installation` runs as `root` during Docker image build.

Example:

```yaml
installation: apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```

Tips:

- Clean apt lists after installs.
- Keep scripts deterministic.
- Prefer the smallest dependency set that gets the job done.
- If a skill needs no setup, omit `installation`.
