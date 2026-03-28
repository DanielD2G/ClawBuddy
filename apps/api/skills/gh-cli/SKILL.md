---
name: gh-cli
description: Interact with GitHub repositories, issues, pull requests, releases,
  Actions, and more via the GitHub CLI.
compatibility: opencode
clawbuddy:
  displayName: GitHub CLI
  version: 1.0.0
  icon: Github
  category: integrations
  type: bash
  networkAccess: true
  installation: apt-get update && apt-get install -y --no-install-recommends gh &&
    rm -rf /var/lib/apt/lists/*
  tools:
    - name: gh_command
      description: 'Execute a GitHub CLI command. The command should NOT include the
        "gh" prefix. Examples: "repo list", "issue create -R owner/repo --title
        Bug --body Details", "pr list -R owner/repo --state open".'
      prefix: gh
      parameters:
        type: object
        properties:
          command:
            type: string
            description: The gh CLI command (without the "gh" prefix), e.g. "repo list",
              "issue view 123 -R owner/repo", "api repos/{owner}/{repo}/issues
              --jq '.[].title'"
          timeout:
            type: number
            description: 'Timeout in seconds (default: 30, max: 300)'
        required:
          - command
  inputs:
    gh_token:
      type: secret
      description: GitHub Personal Access Token (classic or fine-grained)
      placeholder: ghp_xxxxxxxxxxxx
---

You have access to the GitHub CLI (`gh`) via the `gh_command` tool. The token is pre-configured — do NOT run `gh auth login`.

## Command reference

All commands below omit the `gh` prefix (it is added automatically).

### Repositories

```
repo list [OWNER] [--limit N] [--json name,url,...]
repo view OWNER/REPO [--json ...]
repo create NAME [--public|--private] [--description TEXT]
repo clone OWNER/REPO
repo fork OWNER/REPO [--clone=false]
repo edit OWNER/REPO [--description TEXT] [--visibility public|private]
repo delete OWNER/REPO --yes
repo archive OWNER/REPO --yes
repo sync [OWNER/REPO]
```

### Issues

Use `-R OWNER/REPO` to target a specific repository.

```
issue list [-R OWNER/REPO] [--state open|closed|all] [--label NAME] [--assignee USER] [--limit N] [--json number,title,state,...]
issue view NUMBER [-R OWNER/REPO] [--json ...]
issue create [-R OWNER/REPO] --title TITLE --body BODY [--label NAME] [--assignee USER] [--milestone NAME]
issue close NUMBER [-R OWNER/REPO]
issue reopen NUMBER [-R OWNER/REPO]
issue comment NUMBER [-R OWNER/REPO] --body TEXT
issue edit NUMBER [-R OWNER/REPO] [--title TEXT] [--body TEXT] [--add-label NAME] [--remove-label NAME] [--add-assignee USER]
issue pin NUMBER [-R OWNER/REPO]
issue transfer NUMBER [-R OWNER/REPO] DEST-REPO
issue lock NUMBER [-R OWNER/REPO] [--reason spam|off-topic|resolved|too-heated]
```

### Pull Requests

Use `-R OWNER/REPO` to target a specific repository.

```
pr list [-R OWNER/REPO] [--state open|closed|merged|all] [--label NAME] [--base BRANCH] [--head BRANCH] [--limit N] [--json number,title,state,...]
pr view NUMBER [-R OWNER/REPO] [--json ...]
pr create [-R OWNER/REPO] --title TITLE --body BODY [--base BRANCH] [--head BRANCH] [--draft] [--label NAME] [--reviewer USER]
pr merge NUMBER [-R OWNER/REPO] [--merge|--squash|--rebase] [--delete-branch] [--auto]
pr close NUMBER [-R OWNER/REPO]
pr reopen NUMBER [-R OWNER/REPO]
pr comment NUMBER [-R OWNER/REPO] --body TEXT
pr review NUMBER [-R OWNER/REPO] --approve|--request-changes|--comment [--body TEXT]
pr diff NUMBER [-R OWNER/REPO]
pr checks NUMBER [-R OWNER/REPO]
pr edit NUMBER [-R OWNER/REPO] [--title TEXT] [--body TEXT] [--add-label NAME] [--add-reviewer USER]
pr ready NUMBER [-R OWNER/REPO]
pr revert NUMBER [-R OWNER/REPO] [--body TEXT]
```

### Releases

```
release list [-R OWNER/REPO] [--limit N]
release view TAG [-R OWNER/REPO]
release create TAG [-R OWNER/REPO] [--title TEXT] [--notes TEXT] [--draft] [--prerelease] [--target BRANCH] [FILES...]
release edit TAG [-R OWNER/REPO] [--title TEXT] [--notes TEXT] [--draft|--prerelease]
release download TAG [-R OWNER/REPO] [--pattern GLOB] [--dir PATH]
release upload TAG [-R OWNER/REPO] FILES...
release delete TAG [-R OWNER/REPO] --yes
```

### Gists

```
gist list [--limit N] [--public|--secret]
gist view ID
gist create [FILES...] [--public] [--desc TEXT]
gist edit ID [--add FILE] [--remove FILE]
gist delete ID
```

### GitHub Actions

```
run list [-R OWNER/REPO] [--workflow NAME] [--status completed|in_progress|queued|failure|success] [--limit N] [--json ...]
run view RUN_ID [-R OWNER/REPO] [--log|--log-failed]
run watch RUN_ID [-R OWNER/REPO]
run cancel RUN_ID [-R OWNER/REPO]
run rerun RUN_ID [-R OWNER/REPO] [--failed]
run download RUN_ID [-R OWNER/REPO] [--name ARTIFACT] [--dir PATH]
workflow list [-R OWNER/REPO]
workflow view ID|NAME [-R OWNER/REPO]
workflow run ID|NAME [-R OWNER/REPO] [-f key=value]
workflow enable ID|NAME [-R OWNER/REPO]
workflow disable ID|NAME [-R OWNER/REPO]
```

### Search (cross-repository)

```
search repos QUERY [--limit N] [--json ...]
search issues QUERY [--limit N] [--json ...]
search prs QUERY [--limit N] [--json ...]
search commits QUERY [--limit N] [--json ...]
search code QUERY [--limit N] [--json ...]
```

Search uses GitHub search syntax: `is:open`, `label:bug`, `author:USER`, `repo:OWNER/REPO`, `language:python`, etc.

### Secrets & Variables

```
secret list [-R OWNER/REPO]
secret set NAME [-R OWNER/REPO] --body VALUE
secret delete NAME [-R OWNER/REPO]
variable list [-R OWNER/REPO]
variable get NAME [-R OWNER/REPO]
variable set NAME [-R OWNER/REPO] --body VALUE
variable delete NAME [-R OWNER/REPO]
```

### Labels

```
label list [-R OWNER/REPO]
label create NAME [-R OWNER/REPO] [--color HEX] [--description TEXT]
label edit NAME [-R OWNER/REPO] [--name NEW] [--color HEX] [--description TEXT]
label delete NAME [-R OWNER/REPO] --yes
label clone SOURCE-REPO [-R DEST-REPO]
```

### Projects (GitHub Projects v2)

```
project list --owner OWNER
project view NUMBER --owner OWNER
project create --owner OWNER --title TEXT
project edit NUMBER --owner OWNER [--title TEXT] [--description TEXT]
project item-list NUMBER --owner OWNER [--limit N] [--json ...]
project item-add NUMBER --owner OWNER --url ISSUE_OR_PR_URL
project item-create NUMBER --owner OWNER --title TEXT
project item-edit ITEM_ID --project-id PROJECT_ID [--field-id FIELD_ID --text VALUE]
project item-delete NUMBER --owner OWNER --id ITEM_ID
project field-list NUMBER --owner OWNER
project close NUMBER --owner OWNER
project delete NUMBER --owner OWNER
```

### API (raw REST/GraphQL)

For anything not covered above, use the GitHub API directly:

```
api ENDPOINT [--method GET|POST|PATCH|PUT|DELETE] [-f key=value] [-F key=value] [--jq EXPR] [--paginate]
```

Placeholders `{owner}`, `{repo}`, `{branch}` are auto-resolved from GH_REPO if set.
Examples:

- `api repos/OWNER/REPO/contributors --jq '.[].login'`
- `api repos/OWNER/REPO/issues/123/comments -f body='Comment text'`
- `api graphql -f query='{ viewer { login } }'`

## Important rules

1. **Structured output**: prefer `--json field1,field2 --jq '.[]|...'` for clean, parseable results
2. **Target repos**: use `-R OWNER/REPO` to operate on any repo (no need to clone first)
3. **Confirm destructive actions**: always confirm with the user before delete, close, merge, or force-push operations
4. **Large results**: use `--limit N` or pipe through `head` to avoid flooding the output
5. **Never run** `gh auth login` or `gh auth setup-git` — authentication is handled via the GH_TOKEN env var
6. **Formatting**: use `--json` with `--jq` to extract specific fields; for human-readable summaries, format the output yourself
