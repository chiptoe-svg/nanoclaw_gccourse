---
name: image-metadata
description: Read an image file's basic facts — format, dimensions, aspect ratio, orientation, file size, megapixels. Use when the user attaches an image and asks about its size, dimensions, resolution, or whether it fits a format (e.g. a square logo, a banner aspect ratio).
allowed-tools: Bash(python3:*)
---

# Image info

When the user attaches an image, the message includes a marker like:

```
[image: photo.jpg — saved to /workspace/agent/attachments/playground_xxx_0.jpg]
```

That path is the image file on disk. To read its metadata, run the bundled
script with the path:

```bash
python3 /app/skills/image-metadata/scripts/metadata.py "/workspace/agent/attachments/playground_xxx_0.jpg"
```

It prints the format, file size, pixel dimensions, aspect ratio, orientation
(landscape / portrait / square), and megapixels. No API key or network needed —
it parses the file header directly.

Use the output to answer questions like "what are the dimensions?", "is this
square?", "what's the aspect ratio?", or to judge whether a photo is high enough
resolution for a print ad vs. a social post.

This skill reads **facts** about the file. It does not look at the picture
content — for "what's in this photo?" the user needs the **Image vision** skill.
