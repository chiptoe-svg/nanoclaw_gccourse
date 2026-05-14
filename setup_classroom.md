# Classroom Setup (this fork)

A complete playbook for deploying NanoClaw as a classroom. Designed to be read
top-to-bottom by a human, OR followed by Claude Code as a single setup pass.

## How to use this file

**Manual:** read each numbered step, run the commands, fill in the placeholders.

**Semi-automated (recommended):** in the repo dir, run `claude`, then ask:

> "Follow setup_classroom.md to set up my classroom. Ask me anything you need."

Claude reads this file, walks each step, and asks you for inputs (roster, course
name, etc.) along the way. You hit Enter to confirm each action.

---

## Prerequisites

Before starting this playbook, you should have:

- [ ] A working NanoClaw install (`bash nanoclaw.sh` completed; playground reachable at `http://<host>:3002/`)
- [ ] Credentials chosen — **native credential proxy** is the default and what we want here (hit Enter at the setup prompt). OneCLI is the wrong choice unless you have a specific reason.
- [ ] Resend account + verified sender. You'll need `RESEND_API_KEY` and `RESEND_FROM_ADDRESS` in `.env`. Free tier is fine for class-sized cohorts.
- [ ] Roster CSV ready (or be ready to type names + emails). Format: header row `name,email`, one student per row.
- [ ] **(Optional)** Google Workspace OAuth credentials at `~/.config/gws/credentials.json` if you want students' agents to read/write Google Docs.

## Step 1 — Install the classroom skill stack

Run these inside `claude` from the repo dir. Each is idempotent (safe to re-run).

```
/add-classroom         # base classroom: per-student agent groups, role tiers
/add-resend            # email channel + Resend integration (skip if already installed)
/add-classroom-pin     # email-PIN 2FA on class-token URLs (closes URL-forwarding gap)
```

Optional layered skills:

```
/add-classroom-gws     # Google Workspace folder per student (instructor OAuth)
/add-classroom-auth    # per-student ChatGPT subscription (Phase 2, advanced)
```

After each install, the agent should remind you to restart the service:

```
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

Restart once at the end (after all skill installs) rather than after each — picks up all migrations + adapter registrations in one boot.

## Step 2 — Verify the install

After restart:

```bash
# Webchat (if you installed it) reachable?
curl -s -I http://127.0.0.1:3100/ | head -1   # 401 expected (auth required)

# /login/pin endpoint reachable?
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3002/login/pin    # 200 expected

# Classroom migrations applied?
pnpm exec tsx scripts/q.ts data/v2.db "SELECT name FROM schema_version WHERE name LIKE '%class%' OR name LIKE '%room%'"
# Should list: class-login-tokens, class-login-pins, classroom-roster, ...
```

If any of those fail, run `/debug` in Claude Code and have it diagnose.

## Step 3 — Provision the class

Run `class-skeleton.ts` with your student names. This creates per-student agent groups, an instructor group, and pairing codes.

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --names "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi,Ivan,Judy" \
  --instructors "Prof.Smith"
```

After it completes:
- Per-student folders exist under `groups/student_NN/`
- `class-roster.csv` is written (name,role; doesn't yet have emails)
- `agent_groups` rows are seeded

## Step 4 — Map students to email addresses

`class-skeleton` creates the rows but doesn't know each student's email. Either:

**Option A — interactive (Claude can prompt you for each):**

> "Add emails to my roster. Names are: Alice, Bob, Carol... Ask me each one's email."

Claude reads `class-roster.csv`, asks per student, writes the email into the `classroom_roster` table.

**Option B — bulk CSV:**

Create `roster-emails.csv` with header `folder,email`:

```
folder,email
student_01,alice@school.edu
student_02,bob@school.edu
...
```

Then:

```bash
while IFS=, read -r folder email; do
  [ "$folder" = "folder" ] && continue  # skip header
  pnpm exec tsx scripts/q.ts data/v2.db \
    "INSERT OR REPLACE INTO classroom_roster (folder, email) VALUES ('$folder', '$email')"
done < roster-emails.csv
```

## Step 5 — Mint + email login URLs

The `scripts/email-class-tokens.ts` script loops the roster, mints a per-student class-token URL via `ncl class-tokens issue`, and emails each student via Resend.

Create `roster.csv` (just `name,email`):

```
name,email
Alice,alice@school.edu
Bob,bob@school.edu
...
```

Dry-run first to see what would be sent:

```bash
pnpm exec tsx scripts/email-class-tokens.ts \
  --roster roster.csv \
  --course "CS101" \
  --dry-run
```

If the output looks right, drop `--dry-run`:

```bash
pnpm exec tsx scripts/email-class-tokens.ts \
  --roster roster.csv \
  --course "CS101"
```

Each student receives an email like:

> Subject: Your AI agent for CS101
>
> Hi Alice,
>
> Your personal AI agent for CS101 is ready. Click the link below to start chatting with it. Bookmark the link — it's how you'll log back in for the rest of the term.
>
> → http://your-host:3002/?token=…

## Step 6 — Student first-login walk-through (for your reference)

When a student clicks their URL:

1. Browser navigates to the playground
2. Class-token redeemer recognizes the token, looks up the student's email
3. Since `/add-classroom-pin` is installed: redirected to `/login/pin?token=…`
4. PIN page auto-issues a 6-digit code → emailed to student's school address
5. Student enters the PIN → playground session cookie set → 302 to `/playground/`
6. Student lands on the **Home tab** of the v3 playground (Profile / Settings / Help)
7. Student switches to **Chat tab** to message their assigned agent
8. Student switches to **Persona / Skills / Models tabs** to tune their agent

Subsequent visits within ~30 days: cookie alone is sufficient, skip the PIN.

## Step 7 — Things to communicate to your students

Email or post to your LMS:

- The URL is a bookmark; click it once, you're in
- First click on a new device: check school email for a 6-digit PIN
- Browser cookies are how you stay logged in — clearing cookies = re-PIN required
- **Don't forward your URL** — even with the PIN, the URL is yours alone
- Lost your URL? Reply to the instructor email or visit the playground's "Lost your link?" form

## Step 8 — Verification + smoke

Open one of the class-token URLs yourself in an incognito window (or borrow a colleague's machine):

1. Click URL → should redirect to `/login/pin`
2. PIN arrives in the test student's email
3. Enter PIN → land on playground Home tab
4. Topbar should show "current agent: student_NN"
5. Chat tab: send a message → agent replies
6. Persona tab: library lists Default agents + Class library (if instructor populated) + empty My library
7. Sign out (Settings → Log out) → back to `/login/pin`

If any of those steps fail, run `/debug` and have it diagnose.

## Step 9 — Iterate

A class has a curated library — personas you want students to start from. Populate the **Class library** so students see them in their Persona tab:

```bash
ls library/class/             # add your class-specific personas here
```

See `library/default-agents/` for the schema — single JSON per entry with `name`, `description`, `persona`, `preferredProvider`, `preferredModel`, `skills`.

Class library is shared across all students. Edits propagate on next playground page load.

## Re-running this playbook

This file is safe to re-run — each step is idempotent. After the first cohort, re-running step 5 with `--rotate` revokes old tokens and emails fresh ones (useful for term resets).

## Troubleshooting

| Symptom | Try |
|---|---|
| Student says "PIN never arrived" | Check `logs/nanoclaw.log` for `class-login-pins: PIN sender threw`. Verify `RESEND_API_KEY` + Resend sender domain verification. |
| PIN page shows "could not start sign-in" | `registerTokenLookup` wasn't wired during install — re-run `/add-classroom-pin` or check the bootstrap code added by step 4 of its SKILL.md. |
| Setup script asked me for OneCLI vault | You picked the wrong option at the credential-mode prompt. Abort with Ctrl-C, rerun `bash nanoclaw.sh`, accept the default (native) by hitting Enter. |
| Students see other students' agents | The v3 playground assigns each student to their own agent via `agent_group_members`. If this is misconfigured, `pnpm exec tsx scripts/q.ts data/v2.db "SELECT * FROM agent_group_members"` shows the wiring. |
| "ncl: command not found" when running `email-class-tokens.ts` | `pnpm install` linked `ncl` to `node_modules/.bin/ncl`. Use the full path or activate the bin: `export PATH="$PWD/node_modules/.bin:$PATH"`. |

---

**Done.** Your classroom is deployed. Send the email from step 5 to the cohort and watch the playground turn into a learning surface.
