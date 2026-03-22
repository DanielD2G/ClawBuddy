"""Google Workspace capability.

Replaces: apps/api/src/capabilities/builtin/google-workspace.ts
"""

from __future__ import annotations

from typing import Any

GOOGLE_WORKSPACE: dict[str, Any] = {
    "slug": "google-workspace",
    "name": "Google Workspace",
    "description": (
        "Google Workspace: Gmail (send, search, read emails), Calendar (agenda, "
        "events, schedule, meetings, appointments), Drive (upload, download, search "
        "files), Tasks, Docs, Sheets, and more."
    ),
    "icon": "Mail",
    "category": "integrations",
    "version": "1.1.0",
    "authType": "oauth-google",
    "skillType": "bash",
    "installationScript": (
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - "
        "&& apt-get install -y nodejs "
        "&& npm install -g @googleworkspace/cli"
    ),
    "sandbox": {"networkAccess": True},
    "tools": [
        {
            "name": "gws_command",
            "description": (
                'Run a Google Workspace CLI command (without the "gws" prefix). '
                "Prefer helper commands (+send, +triage, +agenda, etc.) over raw API calls. Examples:\n"
                "- Inbox summary: gmail +triage --format table\n"
                '- Send email: gmail +send --to user@example.com --subject "Hello" --body "Hi!"\n'
                "- Reply: gmail +reply --message-id MSG_ID --body \"Thanks!\"\n"
                "- Today's agenda: calendar +agenda --today --format table\n"
                "- This week: calendar +agenda --week --format table\n"
                '- Create event: calendar +insert --summary "Meeting" '
                "--start 2026-03-14T10:00:00-03:00 --end 2026-03-14T11:00:00-03:00\n"
                "- Upload file: drive +upload ./file.pdf\n"
                "- Raw API: calendar events list --params "
                "'{\"calendarId\":\"primary\",\"timeMin\":\"2026-03-01T00:00:00Z\","
                "\"timeMax\":\"2026-04-01T00:00:00Z\",\"singleEvents\":true}'\n"
                "- Discover API params: schema calendar.events.list"
            ),
            "prefix": "gws",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": 'The GWS CLI command to execute (without the "gws" prefix)',
                    },
                },
                "required": ["command"],
            },
        },
    ],
    "systemPrompt": """You have access to Google Workspace via the `gws_command` tool.

The GWS CLI has **helper commands** (prefixed with `+`) that are easier and more reliable than raw API calls. **Always prefer helpers when available.**

## Available services
`gmail`, `calendar`, `drive`, `tasks`, `docs`, `sheets`, `slides`, `people`, `chat`, `forms`, `keep`, `meet`

## Output flags (apply to all commands)
- `--format table` — human-readable output (default: json)
- `--format csv` / `--format yaml` — alternative formats
- `--page-all` — auto-paginate all results
- `--dry-run` — validate without sending

---

## Gmail

### Helpers (preferred)
- **Inbox summary:** `gmail +triage [--max N] [--query '<gmail-query>'] --format table`
- **Send email:** `gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!' [--cc bob@example.com] [--bcc secret@example.com] [--html]`
- **Reply:** `gmail +reply --message-id MSG_ID --body 'Thanks!' [--cc extra@example.com] [--html]`
- **Reply all:** `gmail +reply-all --message-id MSG_ID --body 'Sounds good!' [--remove bob@example.com]`
- **Forward:** `gmail +forward --message-id MSG_ID --to dave@example.com [--body 'FYI see below']`

### Raw API (for operations without helpers)
- **Search emails:** `gmail users messages list --params '{"userId":"me","q":"from:boss newer_than:7d","maxResults":10}'`
- **Read email:** `gmail users messages get --params '{"userId":"me","id":"MSG_ID","format":"full"}'`
- **List labels:** `gmail users labels list --params '{"userId":"me"}'`
- **Modify labels:** `gmail users messages modify --params '{"userId":"me","id":"MSG_ID"}' --json '{"addLabelIds":["UNREAD"],"removeLabelIds":["INBOX"]}'`

---

## Calendar

### Helpers (preferred)
- **Today's events:** `calendar +agenda --today --format table`
- **Tomorrow:** `calendar +agenda --tomorrow --format table`
- **This week:** `calendar +agenda --week --format table`
- **Next N days:** `calendar +agenda --days 7 --format table`
- **Specific calendar:** `calendar +agenda --today --calendar 'Work' --format table`
- **With timezone:** `calendar +agenda --today --timezone America/New_York --format table`
- **Create event:** `calendar +insert --summary 'Standup' --start '2026-03-14T09:00:00-03:00' --end '2026-03-14T09:30:00-03:00' [--location 'Room A'] [--attendee alice@example.com] [--calendar CALENDAR_ID]`

### Raw API (for operations without helpers)
- **List events with date range:** `calendar events list --params '{"calendarId":"primary","timeMin":"2026-03-01T00:00:00Z","timeMax":"2026-04-01T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'`
- **List calendars:** `calendar calendarList list --format table`
- **Update event:** `calendar events patch --params '{"calendarId":"primary","eventId":"EVENT_ID"}' --json '{"summary":"Updated Title"}'`
- **Delete event:** `calendar events delete --params '{"calendarId":"primary","eventId":"EVENT_ID"}'`

**Important for raw calendar API:**
- Timestamps MUST be RFC3339 with timezone: `2026-03-14T10:00:00-03:00` or `2026-03-14T10:00:00Z`
- Always include `"singleEvents":true` when filtering by time range — otherwise recurring events appear as a single entry and time filters may not work correctly
- Use `"orderBy":"startTime"` with `singleEvents:true` to get chronological results

---

## Drive

### Helpers (preferred)
- **Upload file:** `drive +upload ./report.pdf [--parent FOLDER_ID] [--name 'Sales Report.pdf']`

### Raw API
- **List files:** `drive files list --params '{"pageSize":10}' --format table`
- **Search files:** `drive files list --params '{"q":"name contains \\'report\\' and mimeType=\\'application/pdf\\'","pageSize":10}'`
- **Get file metadata:** `drive files get --params '{"fileId":"FILE_ID","fields":"id,name,mimeType,size,webViewLink"}'`
- **Download file:** `drive files get --params '{"fileId":"FILE_ID","alt":"media"}' --output ./downloaded-file.pdf`
- **Create folder:** `drive files create --json '{"name":"New Folder","mimeType":"application/vnd.google-apps.folder"}'`

---

## Tasks
- **List task lists:** `tasks tasklists list --format table`
- **List tasks:** `tasks tasks list --params '{"tasklist":"TASKLIST_ID"}' --format table`
- **Create task:** `tasks tasks insert --params '{"tasklist":"TASKLIST_ID"}' --json '{"title":"Buy groceries","due":"2026-03-15T00:00:00Z"}'`
- **Complete task:** `tasks tasks patch --params '{"tasklist":"TASKLIST_ID","task":"TASK_ID"}' --json '{"status":"completed"}'`

---

## Discovering API parameters
Run `schema <service.resource.method>` to see all available parameters for any API call:
`schema calendar.events.list`, `schema gmail.users.messages.list`, `schema drive.files.list`

---

## Important rules
- Always confirm with the user before sending, replying, or forwarding emails
- When listing/searching, summarize results concisely — don't dump raw JSON
- For reading emails, extract and present the relevant headers (From, Subject, Date) and body text
- Use `--format table` for user-facing output
- Use helpers (`+agenda`, `+triage`, `+send`, etc.) whenever possible — they handle formatting and edge cases automatically""",
    "configSchema": [
        {
            "key": "gwsCredentialsFile",
            "label": "GWS Credentials",
            "type": "password",
            "required": False,
            "description": "Populated automatically via OAuth",
            "envVar": "_GWS_CREDENTIALS_FILE",
        },
        {
            "key": "email",
            "label": "Connected Account",
            "type": "string",
            "required": False,
            "description": "The connected Google account email",
            "envVar": "GWS_EMAIL",
        },
    ],
}
