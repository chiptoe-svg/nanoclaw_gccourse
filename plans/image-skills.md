# Image attachment skills (vision + metadata)

**Goal:** Let students upload a JPG, see the agent fail to use it without a skill,
then add a skill (with real code) that processes the image. Two skills.

**Context:** Uploaded JPGs already land in the container at
`/workspace/agent/attachments/playground_<id>_<i>.jpg`. As of `1c76d15` the
agent now receives the path in its prompt as `[image: <name> — saved to <path>]`
(formatter `formatImages`). pi has NO native vision, so without a skill the agent
has the path but cannot interpret the pixels → fails. A skill ships real code
(a script) that reads the file.

## Phase 1 — image-metadata skill (DONE-criteria: agent reports W×H etc.)

- `container/skills/image-metadata/SKILL.md` — frontmatter `allowed-tools: Bash(python3:*)`,
  instructs: when an `[image: … — saved to <path>]` marker is present, run
  `python3 /app/skills/image-metadata/scripts/metadata.py <path>`.
- `scripts/metadata.py` — **stdlib only** (no Pillow). Parse JPEG SOFn markers for
  width/height; report format, file size (bytes/KB), W×H, aspect ratio, megapixels,
  orientation (landscape/portrait/square). Print human-readable lines.
- Verify: run the script directly on a real uploaded JPEG; confirm sane output.

## Phase 2 — image-vision skill (DONE-criteria: agent returns a description)

- `container/skills/image-vision/SKILL.md` — instructs: run
  `python3 /app/skills/image-vision/scripts/describe.py <path> ["question"]`.
- `scripts/describe.py` — **stdlib `urllib`**. base64-encode the JPG, POST to the
  OpenAI-Platform vision endpoint via the proxy:
  derive gateway from `OPENAI_BASE_URL` (`http://<gw>:3001/openai/v1`) → swap
  `/openai/` → `/openai-platform/`, call `/v1/chat/completions` with model
  `gpt-4o-mini`, `Authorization: Bearer placeholder` (proxy injects the real
  `OPENAI_API_KEY`), an `image_url` data-URL content block + the user's question.
  Print the description; on HTTP/auth error print a clear message.
- Verify: run directly on a real JPEG; confirm a description comes back (or a clear
  error if the platform key lacks vision access).

## Phase 3 — surface in the simple tab

- `simple-config.ts SKILL_TITLE_OVERRIDES`: `image-vision` → "Image vision",
  `image-metadata` → "Image info".
- Add both to the default-participant slot's `skills` list (install-local) so they
  appear UNCHECKED in the simple tab for students to add. (Not committed — group/slot
  files are install-specific.)

## Notes
- `container/skills` is live-mounted RO → no image rebuild; new skill dirs appear on
  next container spawn.
- Keep scripts dependency-free so they work without `install_packages`.
- Do NOT wire native vision — the "add a skill to unlock images" pedagogy depends on
  the agent being unable to use the image until a skill's script does it.
