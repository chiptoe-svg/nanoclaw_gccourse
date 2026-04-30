# Google Workspace CLI (gws)

Access Google Workspace APIs from the command line: Drive, Gmail, Calendar, Sheets, Docs, Tasks, and more.

Authentication is pre-configured. Just run `gws` commands directly.

## Quick Reference

### Gmail
```bash
# List recent messages
gws gmail users.messages list --params '{"userId": "me", "maxResults": 5}'

# Read a message
gws gmail users.messages get --params '{"userId": "me", "id": "MESSAGE_ID", "format": "full"}'

# Send an email
gws gmail +send --to "recipient@example.com" --subject "Subject" --body "Message body"

# Reply to an email
gws gmail +reply --message-id "MESSAGE_ID" --body "Reply text"

# Triage inbox (unread summary)
gws gmail +triage
```

### Google Drive
```bash
# List files
gws drive files list --params '{"q": "trashed=false", "pageSize": 10}'

# Search for files
gws drive files list --params '{"q": "name contains '\''report'\'' and trashed=false"}'

# Upload a file
gws drive +upload --file "/path/to/file.pdf"

# Download a file
gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' > output.pdf

# Create a folder
gws drive files create --json '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'
```

### Google Calendar
```bash
# List upcoming events
gws calendar +agenda

# Create an event
gws calendar +insert --summary "Meeting" --start "2024-03-15T10:00:00" --end "2024-03-15T11:00:00"

# List events for a date range
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2024-03-14T00:00:00Z", "timeMax": "2024-03-15T00:00:00Z", "singleEvents": true}'
```

### Google Sheets
```bash
# Read data from a sheet
gws sheets +read --spreadsheet-id "SHEET_ID" --range "Sheet1!A1:D10"

# Append rows
gws sheets +append --spreadsheet-id "SHEET_ID" --range "Sheet1" --values '[["col1", "col2", "col3"]]'

# Create a new spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "New Sheet"}}'
```

### Google Docs
```bash
# Create a document
gws docs documents create --json '{"title": "New Document"}'

# Append text to a document
gws docs +write --document-id "DOC_ID" --text "Hello World"
```

### Google Tasks
```bash
# List task lists
gws tasks tasklists list

# List tasks in a list
gws tasks tasks list --params '{"tasklist": "TASKLIST_ID"}'

# Create a task
gws tasks tasks insert --params '{"tasklist": "TASKLIST_ID"}' --json '{"title": "New task", "notes": "Details"}'
```

### Workflows (High-Level Helpers)
```bash
# Morning standup report (meetings + tasks)
gws workflow +standup-report

# Prepare for next meeting
gws workflow +meeting-prep

# Weekly digest
gws workflow +weekly-digest

# Convert email to task
gws workflow +email-to-task --message-id "MESSAGE_ID"
```

## Tips

- All commands output JSON by default — pipe to `jq` for formatting
- Use `--dry-run` to preview any API request before executing
- Use `--page-all` to auto-paginate through all results
- Use `gws <service> --help` to see all available methods for a service
- Use `gws schema <service> <method>` to see the full schema for any API method
