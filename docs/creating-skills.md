# Creating Skills for ClawBuddy

Skills are plugins that extend ClawBuddy's agent with new capabilities. A skill is a `.skill` file (JSON) that defines what the tool does, how to install its dependencies, and how to execute it inside a sandboxed Docker container.

## Skill File Format

```json
{
  "name": "My Skill",
  "slug": "my-skill",
  "description": "What the skill does.",
  "version": "1.0.0",
  "icon": "Terminal",
  "category": "general",
  "type": "python",
  "networkAccess": false,
  "instructions": "LLM instructions here...",
  "installation": "pip3 install some-package",
  "tools": [ ... ],
  "inputs": { ... }
}
```

## Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name shown in the UI |
| `slug` | Yes | Unique identifier. Lowercase, hyphens only (e.g. `ml-search`) |
| `description` | Yes | Short description of the skill |
| `version` | No | Semver string. Defaults to `"1.0.0"` |
| `icon` | No | Lucide icon name (e.g. `Terminal`, `Cloud`, `ShoppingCart`) |
| `category` | No | Grouping label. Defaults to `"general"`. Examples: `cloud`, `devops`, `search`, `languages` |
| `type` | Yes | Runtime: `"bash"`, `"python"`, or `"js"` |
| `networkAccess` | No | Whether the sandbox container gets network access. Defaults to `false` |
| `instructions` | Yes | Markdown prompt injected into the LLM system prompt. Tells the AI when and how to use the tool |
| `installation` | No | Shell commands to install dependencies in the Docker image (runs as root) |
| `tools` | Yes | Array of tool definitions (at least one) |
| `inputs` | No | Configuration inputs the admin provides (API keys, settings) |

## Tools

Each tool defines a function the LLM can call. There are two execution modes:

### Mode 1: Command tools (with `prefix`)

The LLM sends a `command` argument, and the skill prepends a prefix before executing it.

```json
{
  "name": "aws_command",
  "description": "Execute an AWS CLI command (without the 'aws' prefix).",
  "prefix": "aws",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "e.g. 's3 ls' or 'ec2 describe-instances'" }
    },
    "required": ["command"]
  }
}
```

When the LLM calls `aws_command(command="s3 ls")`, the sandbox runs `aws s3 ls`.

### Mode 2: Script tools (with `script`)

The tool embeds the full source code. Arguments are passed as CLI positional arguments in the order defined by `required`, then remaining args alphabetically.

```json
{
  "name": "ml_search",
  "description": "Search products on MercadoLibre.",
  "script": "import sys, json, httpx\nquery = sys.argv[1]\n# ... fetch and parse ...\nprint(json.dumps(results))",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Search query" }
    },
    "required": ["query"]
  }
}
```

When the LLM calls `ml_search(query="rtx 3090")`, the sandbox:
1. Writes the script to `/tmp/_skill_ml_search.py`
2. Runs `python3 /tmp/_skill_ml_search.py "rtx 3090"`

The script reads arguments via:
- **Python**: `sys.argv[1]`, `sys.argv[2]`, ...
- **Bash**: `$1`, `$2`, ...
- **JavaScript**: `process.argv[2]`, `process.argv[3]`, ...

Output goes to stdout and is returned to the LLM.

### Mode 3: Generic executor (no `prefix` or `script`)

Falls back to the runtime's default behavior based on `type`:
- `bash` → executes `args.command` directly
- `python` → runs `python3 -c <args.code>`
- `js` → runs `node -e <args.code>`

## Inputs

Inputs define configuration that an admin provides through the UI. Values are injected as environment variables into the sandbox.

### Short form

```json
"inputs": {
  "api_key": "secret",
  "region": "var"
}
```

- `"var"` → plain text field, env var `REGION`
- `"secret"` → password field (encrypted at rest), env var `API_KEY`

The env var name is the key uppercased.

### Extended form (with defaults)

```json
"inputs": {
  "aws_default_region": {
    "type": "var",
    "default": "us-east-1",
    "description": "AWS region to use",
    "placeholder": "us-east-1"
  },
  "docker_host": {
    "type": "var",
    "default": "unix:///var/run/docker.sock"
  },
  "api_token": {
    "type": "secret",
    "description": "API authentication token"
  }
}
```

Both forms can be mixed in the same `inputs` object.

## Installation Scripts

The `installation` field contains shell commands that run as `root` during Docker image build. This is where you install system packages, CLIs, or language libraries.

```json
"installation": "apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*"
```

Tips:
- The base image is Ubuntu 22.04 with `curl`, `wget`, `jq`, and `git` pre-installed
- Always clean up apt lists: `rm -rf /var/lib/apt/lists/*`
- For multi-arch support, use `dpkg --print-architecture` to detect `arm64` vs `amd64`
- The script is validated by building a test Docker image **before** the skill is saved. If the build fails, the skill is rejected with the build logs shown in the UI
- All enabled skills share one Docker image. Each skill's installation becomes a separate `RUN` layer

## Complete Examples

### Bash skill — Terraform

```json
{
  "name": "Terraform",
  "slug": "terraform",
  "description": "Execute Terraform commands for infrastructure as code.",
  "version": "1.0.0",
  "icon": "Server",
  "category": "devops",
  "type": "bash",
  "networkAccess": true,
  "instructions": "You can run Terraform commands to manage infrastructure. Use terraform_command with subcommands like 'init', 'plan', 'apply'.",
  "installation": "apt-get update && apt-get install -y gnupg software-properties-common && wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp.gpg && echo \"deb [signed-by=/usr/share/keyrings/hashicorp.gpg] https://apt.releases.hashicorp.com jammy main\" > /etc/apt/sources.list.d/hashicorp.list && apt-get update && apt-get install -y terraform && rm -rf /var/lib/apt/lists/*",
  "tools": [
    {
      "name": "terraform_command",
      "description": "Execute a Terraform command (without the 'terraform' prefix).",
      "prefix": "terraform",
      "parameters": {
        "type": "object",
        "properties": {
          "command": { "type": "string", "description": "e.g. 'init', 'plan', 'apply -auto-approve'" }
        },
        "required": ["command"]
      }
    }
  ],
  "inputs": {
    "aws_access_key_id": "var",
    "aws_secret_access_key": "secret"
  }
}
```

### Python skill — with embedded script

```json
{
  "name": "MercadoLibre Search",
  "slug": "ml-search",
  "description": "Search for products on MercadoLibre Argentina.",
  "version": "1.0.0",
  "icon": "ShoppingCart",
  "category": "search",
  "type": "python",
  "networkAccess": true,
  "instructions": "Search for products on MercadoLibre Argentina. Pass a query like 'rtx 3090' and get a JSON list of products with name, price, url, and image.",
  "installation": "pip3 install httpx parsel",
  "tools": [
    {
      "name": "ml_search",
      "description": "Search products on MercadoLibre. Returns JSON array.",
      "script": "import sys, json, httpx\nfrom parsel import Selector\n\nquery = sys.argv[1]\nurl = f'https://listado.mercadolibre.com.ar/{query}'\nheaders = {'User-Agent': 'Mozilla/5.0 ...'}\nwith httpx.Client(follow_redirects=True, timeout=30.0) as client:\n    r = client.get(url, headers=headers)\nsel = Selector(text=r.text)\nproducts = []\nfor item in sel.css('li.ui-search-layout__item'):\n    title = item.css('a.poly-component__title::text').get()\n    pf = item.css('span.andes-money-amount__fraction::text').get()\n    price = pf.replace('.', '') if pf else None\n    if title and price:\n        products.append({'name': title.strip(), 'price': price})\nprint(json.dumps(products, ensure_ascii=False))",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query, e.g. 'rtx 3090'" }
        },
        "required": ["query"]
      }
    }
  ]
}
```

### JavaScript skill — simple utility

```json
{
  "name": "JSON Formatter",
  "slug": "json-formatter",
  "description": "Format and validate JSON data.",
  "version": "1.0.0",
  "icon": "Braces",
  "category": "utilities",
  "type": "js",
  "networkAccess": false,
  "instructions": "Format or validate JSON strings. Pass raw JSON and get back pretty-printed output.",
  "tools": [
    {
      "name": "format_json",
      "description": "Pretty-print and validate a JSON string.",
      "script": "const input = process.argv[2];\ntry {\n  const parsed = JSON.parse(input);\n  console.log(JSON.stringify(parsed, null, 2));\n} catch (e) {\n  console.error('Invalid JSON:', e.message);\n  process.exit(1);\n}",
      "parameters": {
        "type": "object",
        "properties": {
          "json_string": { "type": "string", "description": "The JSON string to format" }
        },
        "required": ["json_string"]
      }
    }
  ]
}
```

## Installing a Skill

1. Go to **Admin > Skills** in the ClawBuddy UI
2. Click **Upload Skill** and select your `.skill` file
3. If the skill has an `installation` script, a Docker build runs — you'll see the build logs in real time
4. If the build succeeds, the skill is saved and appears in the list
5. If the build fails, the skill is rejected and you'll see the error logs
6. Enable the skill from **Admin > Capabilities** and configure any required inputs

Skills placed in `apps/api/skills/` are automatically synced to MinIO and loaded on server startup.
