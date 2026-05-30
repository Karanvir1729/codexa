export interface ParsedCodexEvent {
  type: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function parseCodexJsonl(raw: string): ParsedCodexEvent[] {
  const events: ParsedCodexEvent[] = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as ParsedCodexEvent;
      if (parsed && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // Ignore non-JSONL stderr and malformed lines.
    }
  }
  return events;
}

export function extractFinalAgentText(events: ParsedCodexEvent[]) {
  let finalText = "";
  for (const event of events) {
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      finalText = event.item.text;
    }
  }
  return finalText.trim();
}
