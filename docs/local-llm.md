# Local LLM for Class Deploys

NanoClaw's credential proxy multiplexes `/openai/*` traffic to whatever host is in `OPENAI_BASE_URL`. Point it at a local OpenAI-compatible server on your host and the class runs entirely offline — no OpenAI API spend, no rate limits, no network dependency. Cost-economical for RAG / experiment-heavy lab content where every query would otherwise hit a paid API.

This runbook covers three popular options on Apple Silicon (mlx-omni-server, Ollama, LM Studio) and the matching `.env` config. The NanoClaw side is **one env var flip**; the work is choosing + running the server.

## How it fits together

```
Class agent group (agent_provider=codex)
   └─ Codex CLI in container
       └─ HTTP POST → ${OPENAI_BASE_URL}/v1/chat/completions
           └─ NanoClaw credential proxy (host:3001)
               └─ Rewrites Authorization: Bearer ${OPENAI_API_KEY}
                   └─ Forwards to ${OPENAI_BASE_URL} (your local server)
                       └─ Local model on the Mac Studio
```

The proxy passes the `model` parameter through unchanged. Whatever model name your local server advertises, the codex CLI can request by name.

## Option 1 — mlx-omni-server (recommended on Apple Silicon)

[mlx-omni-server](https://github.com/madroidmaq/mlx-omni-server) is an OpenAI-compatible server built on MLX. Loads GGUF / MLX-native models from local disk; exposes `/v1/chat/completions` and `/v1/models`.

### Install + run

```bash
# Install (Python — uses uv or pip)
pip install mlx-omni-server

# Run on port 8080, load a model from local cache (Hugging Face cache by default)
mlx-omni-server \
  --host 127.0.0.1 \
  --port 8080 \
  --model Qwen/Qwen2.5-Coder-32B-Instruct-MLX-4bit
```

First start downloads the model (~18 GB for the 32B Q4). Subsequent starts are instant.

### `.env` config

```bash
# Point NanoClaw's /openai/* route at the local server.
OPENAI_BASE_URL=http://127.0.0.1:8080

# OpenAI SDKs refuse to init without a key — set anything non-empty.
# mlx-omni-server ignores it (no auth on a localhost-only listener).
OPENAI_API_KEY=local

# Default model the codex CLI requests when no per-agent model is set.
OPENAI_MODEL=qwen2.5-coder-32b-instruct-mlx-4bit
```

Restart NanoClaw (`systemctl --user restart nanoclaw` on Linux; `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` on macOS) and the proxy picks up the new upstream.

## Option 2 — Ollama (cross-platform, slower than MLX)

[Ollama](https://ollama.com) ships an OpenAI-compatible endpoint at `/v1/*` since v0.1.30. Backend is llama.cpp + Metal on Apple Silicon — slower than MLX but the install story is friendlier and the model catalog is larger.

### Install + run

```bash
brew install ollama   # or download the .app

# Pull a model (one-time per model)
ollama pull qwen2.5-coder:32b

# Daemon runs on 11434 by default
ollama serve
```

### `.env` config

```bash
OPENAI_BASE_URL=http://127.0.0.1:11434
OPENAI_API_KEY=local
OPENAI_MODEL=qwen2.5-coder:32b
```

## Option 3 — LM Studio (GUI)

[LM Studio](https://lmstudio.ai) has a built-in OpenAI-compatible server toggle. Easiest for instructors who'd rather click than CLI.

1. Open LM Studio → Models → download a model (e.g. Qwen 2.5 Coder 32B Q4).
2. Open the **Local Server** tab → load the model → click **Start Server**.
3. Note the URL it prints (default `http://127.0.0.1:1234`).
4. Set `.env`:

```bash
OPENAI_BASE_URL=http://127.0.0.1:1234
OPENAI_API_KEY=local
OPENAI_MODEL=qwen2.5-coder-32b-instruct
```

## Sizing for a class

A single local model on one Mac Studio queues student requests serially. Some math:

- **30 students** in a 90-minute lab session.
- Each message ≈ **5 s** wall time on a 32B Q4 MLX model (depends on prompt + output length).
- If every student sends a message **simultaneously**, last student waits **~2.5 minutes**.
- Realistically request distribution is uneven — expect ≤10 s tail latency, not 2.5 min.

If queueing bites:

- **Drop to a smaller model.** Qwen 2.5 14B is ~3× faster and 80% as smart for most coding tasks.
- **Run two servers** on two ports, route half the agent groups to each via per-group `OPENAI_BASE_URL` overrides (Phase 2 work — provider-settings panel).
- **Switch to vLLM** if you have a GPU host elsewhere. It batches inference and scales much better than llama.cpp / MLX for concurrent load. Same OpenAI-compat surface.

## How to verify it's working

After `.env` change + restart:

```bash
# Should return your local server's model list, not OpenAI's
curl -s http://127.0.0.1:3001/openai/v1/models \
  -H "Authorization: Bearer placeholder" \
  -H "X-NanoClaw-Agent-Group: <some-agent-id>" \
  | head
```

Then trigger a real agent message via Telegram / playground and watch the model server logs — you should see the request hit your local server, not `api.openai.com`.

## Troubleshooting

### `502 OPENAI_API_KEY is not set on the host`

Set any non-empty placeholder: `OPENAI_API_KEY=local` in `.env`, restart.

### `connect ECONNREFUSED 127.0.0.1:8080`

Your local model server isn't running. Start it; verify with `curl http://127.0.0.1:8080/v1/models`.

### Codex CLI complains about model name

The model name in `OPENAI_MODEL` (and any per-group `model` override) must exactly match what your local server advertises. List via `curl http://127.0.0.1:<port>/v1/models | jq .data[].id`.

### Container can't reach `127.0.0.1`

Inside a container `127.0.0.1` is the container, not the host. **You don't need to change anything** — the container's `OPENAI_BASE_URL` env points at the credential proxy on `host.docker.internal:3001`, and the proxy (running on the host) sees `127.0.0.1` as the host. Only `OPENAI_BASE_URL` in `.env` (read by the host proxy) matters.

### Slow on first request after idle

mlx-omni-server lazy-loads the model. First request after `--model` mismatch or idle eviction takes ~30 s of "warming up." Subsequent requests are fast. Use `mlx-omni-server --preload` (or LM Studio's "keep loaded" toggle) to avoid the cold start.

## Mode A and Mode B compatibility

Local LLM works in either deployment mode:

- **Mode A** (shared class workspace): all class agents share the local model. No per-student auth needed — the local server doesn't care about the Bearer token.
- **Mode B** (per-person Google + provider auth): students choose between local LLM and their own OAuth'd provider via the Phase 4 provider-settings panel. The codex `auth.json` resolver chain picks the class-shared local-LLM config when no per-student override exists; per-student OAuth shadows it when present.
