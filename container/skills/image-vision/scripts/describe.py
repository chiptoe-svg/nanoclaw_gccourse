#!/usr/bin/env python3
"""Describe what's in an image using a vision model — stdlib only (urllib).

Sends the image to an OpenAI vision model through NanoClaw's credential proxy
(the `/openai-platform` route, which injects the real API key), so no key is
needed in the container.

Usage:  python3 describe.py <path-to-image> ["question"] [--detail low|high|auto]
Example: python3 describe.py /workspace/agent/attachments/playground_x_0.jpg "Is this a good ad photo?" --detail high

Options:
  --detail   Resolution the vision model processes the image at:
               low  ~512px — cheapest, fastest, fine for overall scene/colors
               high tiled at full res — more tokens, better for small text/detail
               auto (default) — the model picks based on the image
  --model    Override the vision model (default: gpt-4o-mini).
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request


def main():
    args = sys.argv[1:]
    detail = "auto"
    model = os.environ.get("NANOCLAW_VISION_MODEL", "gpt-4o-mini")
    positional = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--detail" and i + 1 < len(args):
            detail = args[i + 1]
            i += 2
        elif a == "--model" and i + 1 < len(args):
            model = args[i + 1]
            i += 2
        else:
            positional.append(a)
            i += 1
    if detail not in ("low", "high", "auto"):
        sys.exit("--detail must be one of: low, high, auto")
    if not positional:
        sys.exit('usage: describe.py <path-to-image> ["question"] [--detail low|high|auto] [--model NAME]')
    path = positional[0]
    question = positional[1] if len(positional) > 1 else "Describe this image in detail."
    if not os.path.isfile(path):
        sys.exit(f"file not found: {path}")

    # Reach the vision model via the proxy's /openai route (it injects the real
    # OPENAI_API_KEY). OPENAI_BASE_URL already ends in /openai/v1, so just append
    # the chat-completions path.
    base = os.environ.get("OPENAI_BASE_URL", "")
    if not base:
        sys.exit("OPENAI_BASE_URL is not set — cannot reach the vision model")
    endpoint = base.rstrip("/") + "/chat/completions"

    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    data_url = f"data:image/jpeg;base64,{b64}"

    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": question},
                    {"type": "image_url", "image_url": {"url": data_url, "detail": detail}},
                ],
            }
        ],
        "max_tokens": 600,
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode(),
        # Placeholder — the proxy substitutes the real OPENAI_API_KEY.
        headers={"content-type": "application/json", "authorization": "Bearer placeholder"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        sys.exit(f"vision request failed (HTTP {e.code}): {body}")
    except Exception as e:  # noqa: BLE001 — surface any transport error plainly
        sys.exit(f"vision request error: {e}")

    try:
        print(out["choices"][0]["message"]["content"].strip())
    except (KeyError, IndexError):
        print(json.dumps(out)[:800])


if __name__ == "__main__":
    main()
