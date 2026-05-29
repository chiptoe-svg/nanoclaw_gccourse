/**
 * Pure parser: captured LLM request body → Sections shape.
 * Branches by upstream_route; all OpenAI-compatible routes (openai,
 * openai-platform, omlx, clemson) share the same shape.
 */

export interface MessageSection {
  role: string;
  bytes: number;
}

export interface Sections {
  system: number;
  tools: number;
  messages: MessageSection[];
  totalBytes: number;
  unparseable: boolean;
}

function byteLengthOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);
  return Buffer.byteLength(JSON.stringify(value));
}

export function parseSections(upstreamRoute: string, body: Buffer): Sections {
  const totalBytes = body.length;
  let json: unknown;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    return { system: 0, tools: 0, messages: [], totalBytes, unparseable: true };
  }
  if (typeof json !== 'object' || json === null) {
    return { system: 0, tools: 0, messages: [], totalBytes, unparseable: true };
  }
  const obj = json as Record<string, unknown>;

  if (upstreamRoute === 'anthropic') {
    return {
      system: byteLengthOf(obj.system),
      tools: byteLengthOf(obj.tools),
      messages: Array.isArray(obj.messages)
        ? (obj.messages as Array<{ role?: string }>).map((m) => ({
            role: typeof m.role === 'string' ? m.role : 'unknown',
            bytes: byteLengthOf(m),
          }))
        : [],
      totalBytes,
      unparseable: false,
    };
  }

  // openai / openai-platform / omlx / clemson — all share the OpenAI chat shape.
  // `instructions` is OpenAI's top-level system field; role:'system' messages
  // are also conventionally part of the system bucket.
  const instructionsBytes = byteLengthOf(obj.instructions);
  let systemFromMessages = 0;
  const userMessages: MessageSection[] = [];
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages as Array<{ role?: string }>) {
      const role = typeof m.role === 'string' ? m.role : 'unknown';
      const bytes = byteLengthOf(m);
      if (role === 'system') {
        systemFromMessages += bytes;
      } else {
        userMessages.push({ role, bytes });
      }
    }
  }
  return {
    system: instructionsBytes + systemFromMessages,
    tools: byteLengthOf(obj.tools),
    messages: userMessages,
    totalBytes,
    unparseable: false,
  };
}
