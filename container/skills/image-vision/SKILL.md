---
name: image-vision
description: Look at what's actually in an image — describe the scene, subjects, colors, mood, text, composition. Use when the user attaches a photo and asks what's in it, to critique it, or anything that requires seeing the picture content (not just its file facts).
allowed-tools: Bash(python3:*)
---

# Image vision

When the user attaches an image, the message includes a marker like:

```
[image: photo.jpg — saved to /workspace/agent/attachments/playground_xxx_0.jpg]
```

That path is the image file on disk. To actually SEE the picture, run the
bundled script with the path and (optionally) a question:

```bash
python3 /app/skills/image-vision/scripts/describe.py "/workspace/agent/attachments/playground_xxx_0.jpg" "Is this a strong ad photo? What would you change?"
```

The script sends the image to a vision model and prints back a description /
answer. With no question it just describes the image.

**Resolution / cost knob** — add `--detail`:

```bash
python3 /app/skills/image-vision/scripts/describe.py "<path>" "Read the text on the sign." --detail high
```

- `--detail low` — model sees ~512px. Cheapest and fastest; fine for overall
  scene, colors, mood.
- `--detail high` — image is tiled at full resolution. More tokens (costs more)
  but needed for small text, fine detail, or close inspection.
- `--detail auto` (default) — the model decides.

Use `low` for quick "what's this?" and `high` when the user asks about text in
the image or fine details. (`--model NAME` overrides the vision model.)

Use it for "what's in this photo?", "critique this ad image", "what colors
dominate?", "is there text in it?", "does the composition work?" — anything
that needs looking at the actual pixels.

For plain file facts (dimensions, aspect ratio, file size) you don't need
vision — use the **Image info** skill, which is faster and needs no network.
