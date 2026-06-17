# Simple tab: weather skill + 2-column skill list + skill source viewer

**Request (demo prep):** (1) add a weather skill to the shortlist — "get weather in
chat vs. agent chat" contrast demo; (2) render the skill list in 2 columns;
(3) let students see exactly what's inside a skill (SKILL.md, python scripts) —
opens in a new tab.

## Design

- **Weather skill** — new built-in at `container/skills/weather/`:
  - `SKILL.md` (frontmatter name/description) instructing the agent to run the script.
  - `scripts/weather.py` — stdlib-only python3 (already in the image): Open-Meteo
    geocoding + current weather, no API key. Deliberately short/readable — students
    will open it in the viewer.
  - `container/skills` is bind-mounted read-only at `/app/skills` → **no image
    rebuild**; enabling the skill via the panel syncs the symlink on next spawn.
  - Add `"weather"` to the slot shortlist (`data/config/default-participant/
    container.json` `skills` — untracked data file).
- **2-column list** — `#simple-skills` becomes `display:grid; grid-template-columns:
  1fr 1fr`. The ⓘ description expands within its cell.
- **Source viewer** — REUSE the existing library file API, which already serves
  built-ins: `GET /api/skills/library/built-in/<name>/files` + `/file?path=…`
  (`library.ts` `resolveSkillRoot`, traversal-guarded). No new server code.
  - New static page `public/skill-view.html` (self-contained HTML+JS+CSS, served at
    `/playground/skill-view.html?skill=<name>`): file list sidebar + monospace
    content pane, auto-opens SKILL.md.
  - `renderSkillRows` (simple.js) gains a per-row "view ↗" link, `target="_blank"`.
  - Known limit (accepted): viewer shows the shared built-in copy; per-agent
    custom-skill shadows aren't resolved. Fine for the demo shortlist.

## Added scope (follow-up request, same change)

Friendly shortlist titles via `SKILL_TITLE_OVERRIDES` in simple-config.ts
(agent-browser → "Web Search", pdf-reader → "PDF-reader", pdf → "PDF-read/write",
rag-pdf-ingest → "PDF-Rag ingest"); slot order Web Search, Weather, then the three
PDF variants; "template" removed from the slot.

## Steps

- [x] Plan file (this).
- [x] `container/skills/weather/SKILL.md` + `scripts/weather.py`; test script on host
  (Clemson + Tokyo OK; geocoder fallback strips ", SC").
- [x] Slot: skills = agent-browser, weather, pdf-reader, pdf, rag-pdf-ingest.
- [x] simple-config.ts title overrides (+ test updates).
- [x] style.css: 2-col grid, nowrap rows, view-link style.
- [x] simple.js: "See what's inside ↗" link inside the ⓘ description.
- [x] `public/skill-view.html` (probes built-in → skills → template categories).
- [x] Verified live: 5 skills, 2 columns, titles/order right; viewer shows weather
  SKILL.md + scripts/weather.py; pdf resolves from library cache (13 files).
- [x] `pnpm vitest run src/channels/playground` (313 ✓) + `pnpm run build` clean; commit.
