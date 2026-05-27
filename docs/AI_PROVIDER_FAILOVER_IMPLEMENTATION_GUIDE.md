# AI Provider Failover Implementation Guide

> A field manual for adding an OpenAI fallback path to an Anthropic-native AI agent.
> Based on the production implementation in Simorgh (commits `bc57cb8` → `0c6b91f`, May 2026).

---

## Table of contents

1. [Problem statement](#1-problem-statement)
2. [Architectural choice: parallel loops, not a vendored SDK](#2-architectural-choice-parallel-loops-not-a-vendored-sdk)
3. [The single dispatch seam](#3-the-single-dispatch-seam)
4. [Anthropic vs OpenAI: the differences that actually bite](#4-anthropic-vs-openai-the-differences-that-actually-bite)
5. [Message format translation](#5-message-format-translation)
6. [Tool definitions + tool calls + tool results](#6-tool-definitions--tool-calls--tool-results)
7. [Reasoning / extended thinking](#7-reasoning--extended-thinking)
8. [System prompts](#8-system-prompts)
9. [Streaming](#9-streaming)
10. [Persistence: the provider-agnostic transcript format](#10-persistence-the-provider-agnostic-transcript-format)
11. [Health tracking + circuit-breaker readiness](#11-health-tracking--circuit-breaker-readiness)
12. [UI: fork-on-fallback and the health banner](#12-ui-fork-on-fallback-and-the-health-banner)
13. [Configuration surface](#13-configuration-surface)
14. [The nine gotchas you will hit](#14-the-nine-gotchas-you-will-hit)
15. [Testing strategy](#15-testing-strategy)
16. [Operational properties to plan around](#16-operational-properties-to-plan-around)
17. [Phase 2: automatic failover](#17-phase-2-automatic-failover)
18. [Implementation checklist](#18-implementation-checklist)

---

## 1. Problem statement

If your AI agent talks to exactly one provider and that provider has an incident, your product is dark. Anthropic's API has had three significant outages in the past 12 months (a few hours each). Each one took our entire investigation flow offline because every code path called `anthropic.Anthropic().messages.stream(...)` and there was nowhere to redirect on failure.

The fix is not "retry with backoff" — the outages last 15+ minutes and exponential backoff just stretches the same failure across more time. The fix is **a second provider that can run the same agent**, the same tools, the same prompts, with an output that's indistinguishable from the primary path once the answer lands.

This guide walks through how we did it for our Anthropic-native agent: what code we changed, what we kept untouched, where OpenAI's API is shaped differently than Anthropic's, which differences we had to translate at runtime, and the specific traps we tripped over so you don't have to.

---

## 2. Architectural choice: parallel loops, not a vendored SDK

There are three common ways to add a second provider:

| Approach | What it is | When it works |
|---|---|---|
| **A. Common SDK layer (LiteLLM, LangChain, etc.)** | Wrap a normalizing client over both providers, write all code against the wrapper | Greenfield projects, or when your agent loop is small enough to rewrite |
| **B. Provider abstraction interface in your own code** | Define `class Provider: def run_iteration(...)` and have two implementations | Medium-effort refactor; gives you control but doubles maintenance |
| **C. Parallel native loops with a dispatcher** | Keep the Anthropic-native code untouched. Add a sibling file that implements the same callback contract against OpenAI. Single `if model.startswith("gpt-") → openai_loop else → anthropic_loop` switch at the top. | Existing Anthropic agent; you want the lowest-risk, smallest-diff path |

**We chose C.** Reasons:

- The Anthropic loop had ~800 lines of production-tested code (streaming handlers, tool-call persistence, error classification, budget tracking). Refactoring it into an abstraction risked introducing bugs into the primary path while building the secondary one.
- LiteLLM-style wrappers hide subtle protocol differences (encrypted reasoning content, tool-call ID pairing, cache markers). When those differences matter, they leak through anyway, and now you're debugging through two layers of code.
- The two providers' loops have ~70% overlapping logic but the remaining 30% (tool ID format, reasoning block shape, streaming event types) is shaped very differently. A unified abstraction would either force every line through a switch statement or paper over real distinctions and break on edge cases.

The cost of parallel loops is that ~70% overlap — bug fixes have to go to two places. We mitigated this by keeping shared functions (`load_prompt`, `record_tool_call`, callback signatures) in modules both loops import. The actual provider-touching code is ~250 lines per loop.

**File layout we landed on:**

```
agent/
├── main.py              # Anthropic-native loop. Untouched legacy.
├── openai_loop.py       # OpenAI Responses-API loop. New file.
├── prompts/
│   ├── system_prompt.md
│   └── system_prompt_addendum_openai.md   # Self-identification override
└── tools/               # Tool definitions in Anthropic-native shape.
                         # Converter at request time emits the OpenAI variant.
api/
├── routes/
│   ├── chat.py          # WS handler — calls run_agent_loop(model=...)
│   │                    # The dispatcher inside that function picks the path.
│   └── settings.py      # /provider-health endpoints + Test button
└── services/
    └── provider_health.py   # Rolling 5-min window classification
```

---

## 3. The single dispatch seam

The most important architectural decision: **one seam, at the top of the agent loop**, that picks the provider based on the model name string.

In `agent/main.py:run_agent_loop`, near the very top after argument validation:

```python
# Provider dispatch: any model name starting with "gpt-" routes to
# the parallel loop in openai_loop.py, which mirrors this function's
# callback contract and return shape. Callers don't need to know
# which provider ran the turn.
from agent.openai_loop import is_openai_model, run_agent_loop_openai
if is_openai_model(model):
    return run_agent_loop_openai(
        messages=messages,
        system_prompt=system_prompt,
        model=model,
        max_iterations=max_iterations,
        max_tokens_budget=max_tokens_budget,
        on_tool_call=on_tool_call,
        on_token=on_token,
        on_stats=on_stats,
        on_reasoning_delta=on_reasoning_delta,
        on_reasoning_done=on_reasoning_done,
        # ...every other kwarg passes through identically...
    )
# else: fall through to the existing Anthropic implementation
```

And `is_openai_model` is intentionally trivial:

```python
# agent/openai_loop.py
def is_openai_model(model: str | None) -> bool:
    """True iff the model name looks like an OpenAI ID.

    Today: gpt-5.5, gpt-5, gpt-4o, o1, o3, etc. Anthropic models all
    start with 'claude-'. We pattern-match on the prefix rather than
    maintaining an enum — new OpenAI models slot in for free.
    """
    if not model:
        return False
    return model.startswith(("gpt-", "o1", "o3", "o4-"))
```

Why this matters:
- The dispatcher is **15 lines of code** and the only thing the rest of the app needs to know about provider selection.
- Both loops have **identical signatures** and **identical return shapes** so the dispatcher is a pure pass-through.
- Both loops accept the **same callback interface**, so the WebSocket handler, the UI, and persistence code never branch on provider.
- Adding a third provider later (e.g., Google Gemini) means: add a `gemini_loop.py`, extend `is_openai_model` into a more general matcher, and ship.

**Critical:** keep the dispatcher near the top of `run_agent_loop`, before any Anthropic-specific work (no anthropic-client construction, no Anthropic-shape massaging of messages). The cost of branching late is that you accidentally do Anthropic-only work for an OpenAI run, and the test that catches it is "the OpenAI path crashes at iteration 1."

---

## 4. Anthropic vs OpenAI: the differences that actually bite

This is the section to read carefully. The two APIs look similar at the docs level but diverge in nine specific ways that will break you if you don't translate.

| # | Concept | Anthropic | OpenAI Responses API |
|---|---|---|---|
| 1 | **System prompt** | Top-level `system: str` parameter on `messages.create` | Top-level `instructions: str` parameter on `responses.create` (NOT a message role) |
| 2 | **Message shape** | `messages: [{role, content: str OR list[block]}]` where blocks can be `text`, `tool_use`, `tool_result`, `thinking` | `input: [...]` is a **flat array of input items**, not a nested `messages` array. Items can be `{role, content: [{type:"input_text"\|"output_text", text}]}`, `function_call`, `function_call_output`, `reasoning` |
| 3 | **Tool definitions** | `tools: [{name, description, input_schema, cache_control?}]` | `tools: [{type: "function", name, description, parameters}]` — flat, NOT wrapped under `function:` (that's Chat Completions, which Responses replaces) |
| 4 | **Tool call (in assistant turn)** | Content block: `{type: "tool_use", id: "call_xxx", name, input: {...}}` | Top-level input item: `{type: "function_call", id: "fc_xxx", call_id: "call_xxx", name, arguments: "json-string"}`. **Two IDs**, not one — see gotcha #2. |
| 5 | **Tool result (in user turn)** | Content block: `{type: "tool_result", tool_use_id: "call_xxx", content: "..."}` | Top-level input item: `{type: "function_call_output", call_id: "call_xxx", output: "..."}` — note `call_id` matches the callable id, not the output-item id |
| 6 | **Extended thinking / reasoning** | `{type: "thinking", thinking: "summary text", signature: "opaque-blob"}` content block. The `signature` is the encrypted full reasoning that the API needs back on multi-turn replay. | `{type: "reasoning", id: "rs_xxx", summary: [{type:"summary_text", text}], encrypted_content: "blob"}` input item. The `encrypted_content` is the equivalent of Anthropic's `signature`. |
| 7 | **Reasoning request parameter** | `thinking: {type: "enabled", budget_tokens: N}` (paired with `max_tokens` higher than the budget) | `reasoning: {effort: "minimal"\|"low"\|"medium"\|"high", summary: "auto"\|"detailed"\|"concise"}`. Some models (incl. GPT-5.5) reject `effort: "minimal"` — use `"low"` as the low setting. |
| 8 | **Streaming** | `messages.stream(...)` yields events like `message_start`, `content_block_start`, `content_block_delta {type: "text_delta", text: "..."}`, `content_block_stop`, `message_delta`, `message_stop` | `responses.create(stream=True)` yields events `response.created`, `response.output_item.added`, `response.output_text.delta {delta: "..."}`, `response.reasoning_summary_text.delta`, `response.completed` |
| 9 | **Prompt caching** | Explicit `cache_control: {type: "ephemeral"}` markers on the last system message and last tool definition. Anthropic invalidates on changes. | Automatic on repeated prefixes — no explicit marker. **Drop Anthropic's cache_control markers** when converting tools/messages or OpenAI returns 400. |

A few of these aren't differences in capability — they're differences in protocol shape that have to be translated at the boundary. The next sections show how.

---

## 5. Message format translation

You will store conversation history in **one canonical format** and convert at the boundary. We chose to keep the Anthropic-native shape in the database because:

1. The Anthropic-native blocks are richer (named content types, explicit `tool_use_id` linkage).
2. The first version of the system already stored them this way — we didn't want to migrate years of historical chat data.
3. Conversion Anthropic→OpenAI is well-defined; Conversion OpenAI→Anthropic would have lossy edges (especially around `fc_*` vs `call_*` IDs).

Here's the converter, with annotations on the trickier branches. From `agent/openai_loop.py`:

```python
def convert_messages_to_openai(
    anthropic_messages: list[dict[str, Any]],
    system_prompt: str,
) -> list[dict[str, Any]]:
    """Anthropic-native messages → OpenAI Responses input items.

    Responses API expects a FLAT input array (not a messages array with
    nested content), with these item types:
      - {role: 'user'|'assistant', content: [{type: 'input_text'|'output_text', text}]}
      - {type: 'function_call', id: 'fc_...', call_id: 'call_...', name, arguments: 'json-string'}
      - {type: 'function_call_output', call_id: 'call_...', output: 'string'}
      - {type: 'reasoning', id: 'rs_...', summary: [...], encrypted_content: 'blob'}

    system_prompt is IGNORED here — it's passed to responses.create() via
    the top-level `instructions` parameter, not as a message.
    """
    out: list[dict[str, Any]] = []
    for msg in anthropic_messages:
        role = msg.get("role")
        content = msg.get("content")

        # Case 1: content is a plain string (legacy or simple turn)
        if isinstance(content, str):
            if role == "assistant":
                out.append({
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": content}],
                })
            else:
                out.append({
                    "role": role or "user",
                    "content": [{"type": "input_text", "text": content}],
                })
            continue

        # Case 2: assistant content is a list of blocks
        if role == "assistant":
            text_parts: list[str] = []
            for block in content:
                btype = block.get("type")

                if btype == "thinking":
                    # See section 7 for the reasoning round-trip mechanics.
                    rs_id = block.get("id") or "rs_unknown"
                    enc = block.get("signature") or block.get("encrypted_content") or ""
                    summary_text = block.get("thinking") or block.get("text") or ""
                    item: dict[str, Any] = {
                        "type": "reasoning",
                        "id": rs_id,
                        "summary": (
                            [{"type": "summary_text", "text": summary_text}]
                            if summary_text else []
                        ),
                    }
                    if enc:
                        item["encrypted_content"] = enc
                    out.append(item)

                elif btype == "tool_use":
                    # CRITICAL: two IDs, not one. See gotcha #2.
                    callable_id = block.get("id") or ""
                    fc_id = block.get("openai_item_id") or callable_id
                    # Defensive: if we somehow stored a callable-style id
                    # in the fc_id slot (Anthropic-only session being
                    # forked to OpenAI), synthesize an fc_-prefixed one.
                    if fc_id and not fc_id.startswith("fc_"):
                        fc_id = "fc_" + fc_id.replace("call_", "", 1)
                    out.append({
                        "type": "function_call",
                        "id": fc_id,
                        "call_id": callable_id,
                        "name": block.get("name"),
                        "arguments": json.dumps(block.get("input") or {}, default=str),
                    })

                elif btype == "text":
                    text_parts.append(block.get("text", ""))

            if text_parts:
                out.append({
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "\n".join(text_parts)}],
                })
            continue

        # Case 3: user content is a list of blocks (typically tool_result + optional text)
        if role == "user":
            text_parts = []
            for block in content:
                btype = block.get("type")
                if btype == "tool_result":
                    out.append({
                        "type": "function_call_output",
                        "call_id": block.get("tool_use_id"),
                        "output": str(block.get("content") or ""),
                    })
                elif btype == "text":
                    text_parts.append(block.get("text", ""))
            if text_parts:
                out.append({
                    "role": "user",
                    "content": [{"type": "input_text", "text": "\n".join(text_parts)}],
                })
            continue

    return out
```

And the inverse — converting a fresh OpenAI response back into Anthropic-native blocks for persistence:

```python
def _build_anthropic_assistant_block(
    text: str,
    tool_calls: list[dict[str, Any]],
    reasoning_items: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """OpenAI Responses output → Anthropic-native content blocks.

    Used at end of each iteration to persist the assistant's response
    in the canonical format. Round-trips losslessly so a subsequent
    iteration's converter produces the same OpenAI input.
    """
    blocks: list[dict[str, Any]] = []

    for item in (reasoning_items or []):
        blocks.append({
            "type": "thinking",
            "id": item.get("id"),
            "thinking": item.get("summary_text", ""),
            # Carry encrypted_content as `signature` so the same persisted
            # field works for both providers.
            "signature": item.get("encrypted_content", ""),
        })

    if text:
        blocks.append({"type": "text", "text": text})

    for call in tool_calls:
        args = json.loads(call.get("arguments") or "{}")
        fc_id = call.get("id")        # fc_... — output-item id from this stream
        callable_id = call.get("call_id") or fc_id  # call_... — callable id
        blocks.append({
            "type": "tool_use",
            "id": callable_id,           # canonical tool_use_id for tool_result linkage
            "openai_item_id": fc_id,     # the fc_ id we MUST send back on replay
            "name": call.get("name"),
            "input": args,
        })

    return blocks
```

The key insight: **persist both IDs.** Don't try to be clever and store one. The fc_ id and the call_ id serve different purposes in the protocol and you need both back on the next turn.

---

## 6. Tool definitions + tool calls + tool results

### Tool definitions

Anthropic's tool definitions are flat:

```python
[
    {
        "name": "query_database",
        "description": "Run a SQL query against the audit table.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "SELECT statement"},
                "max_rows": {"type": "integer", "default": 100},
            },
            "required": ["query"],
        },
        "cache_control": {"type": "ephemeral"},  # Anthropic prompt-cache marker
    },
]
```

OpenAI Responses API tool definitions are also flat, but renamed:

```python
[
    {
        "type": "function",   # required tag
        "name": "query_database",
        "description": "Run a SQL query against the audit table.",
        "parameters": {       # NOT "input_schema"
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "SELECT statement"},
                "max_rows": {"type": "integer", "default": 100},
            },
            "required": ["query"],
        },
        # cache_control DROPPED — OpenAI caches automatically
    },
]
```

The converter is six lines:

```python
def convert_tools_to_openai(anthropic_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Anthropic flat → OpenAI Responses flat. cache_control dropped."""
    return [
        {
            "type": "function",
            "name": t["name"],
            "description": t.get("description", ""),
            "parameters": t.get("input_schema") or {"type": "object", "properties": {}},
        }
        for t in anthropic_tools
        if t.get("name")
    ]
```

**Important:** the OpenAI Chat Completions API uses a different shape (`{type: "function", function: {name, description, parameters}}` — nested under `function:`). If you see docs mentioning that, ignore them. We're on the Responses API. See gotcha #1 for why.

### Tool invocations (assistant calling a tool)

OpenAI returns each tool call as **two pieces of information that pair**:

- An **output-item id** (`id: "fc_abc123"`) — uniquely identifies this function-call output item in the response stream.
- A **callable id** (`call_id: "call_xyz789"`) — the identifier the model uses to reference its own call when it later wants to consume the result.

Both come back in the streaming events; you need both on replay. The Anthropic-native `tool_use` block has only one `id` — we extended it with an `openai_item_id` field to carry the `fc_` one.

### Tool results (user supplying tool output back to assistant)

This is where the IDs intersect:

```python
# Anthropic — content block in the user turn
{"type": "tool_result", "tool_use_id": "call_xyz789", "content": "Returned 42 rows."}

# OpenAI Responses — top-level input item (NOT in user content)
{"type": "function_call_output", "call_id": "call_xyz789", "output": "Returned 42 rows."}
```

Note: `tool_use_id` (Anthropic) maps to `call_id` (OpenAI), and **both reference the callable id**, not the output-item id. The `fc_*` id only matters on the function_call itself (when the assistant invokes), not on the function_call_output (when you reply).

---

## 7. Reasoning / extended thinking

This is the trickiest area because the two providers expose conceptually similar features through very different protocols, and **multi-turn replay requires you to send the prior reasoning back on every subsequent call**.

### Anthropic extended thinking

When you enable `thinking: {type: "enabled", budget_tokens: N}` on `messages.create`, the API returns assistant messages with a `thinking` content block before any `text` or `tool_use` blocks:

```python
{
    "role": "assistant",
    "content": [
        {
            "type": "thinking",
            "thinking": "Let me check the audit log first to see if...",  # human-readable summary
            "signature": "long-opaque-base64-blob",   # encrypted full reasoning trace
        },
        {"type": "text", "text": "I'll start by querying..."},
        {"type": "tool_use", "id": "...", "name": "query_database", "input": {...}},
    ],
}
```

On the next API call, you pass the **entire** prior assistant message back, including the `thinking` block with its `signature`. Anthropic validates the signature and uses it as the continuation point — without it, the model loses its reasoning state and either degrades quality or rejects the call (depending on the model).

### OpenAI Responses reasoning

When you set `reasoning: {effort: "high", summary: "auto"}` on `responses.create`, the response stream includes one or more `reasoning` output items:

```python
{
    "type": "reasoning",
    "id": "rs_abc123",
    "summary": [
        {"type": "summary_text", "text": "Let me check the audit log first..."},
    ],
    "encrypted_content": "long-opaque-base64-blob",
}
```

The role of `encrypted_content` is exactly the same as Anthropic's `signature` — it's the encrypted full reasoning trace that has to be passed back on the next call for the model to maintain state.

### Why we store these in the same field

In our DB, the `thinking` block has a `signature` field. The OpenAI converter reuses that same field for OpenAI's `encrypted_content`. The converter and the inverse converter both know about this:

```python
# Convert OUT (Anthropic-native → OpenAI request)
if btype == "thinking":
    enc = block.get("signature") or block.get("encrypted_content") or ""
    item = {"type": "reasoning", "id": block.get("id"),
            "summary": [{"type": "summary_text", "text": block.get("thinking", "")}] if ... else [],
            "encrypted_content": enc}

# Convert IN (OpenAI response → Anthropic-native persistence)
for item in reasoning_items:
    blocks.append({
        "type": "thinking",
        "id": item.get("id"),
        "thinking": item.get("summary_text", ""),
        "signature": item.get("encrypted_content", ""),   # store as signature
    })
```

This way a session that started on Anthropic and was forked to OpenAI (or vice versa) keeps replaying its reasoning state correctly.

### Reasoning request parameter

```python
# Anthropic
client.messages.create(
    model="claude-sonnet-4-6",
    thinking={"type": "enabled", "budget_tokens": 4000},
    max_tokens=8000,  # must be > budget_tokens
    ...,
)

# OpenAI Responses
client.responses.create(
    model="gpt-5.5",
    reasoning={"effort": "high", "summary": "auto"},
    max_output_tokens=8000,
    ...,
)
```

**Gotcha:** GPT-5.5 rejects `reasoning.effort = "minimal"` with a 400. The valid values are `low`, `medium`, `high` (and on some models `xhigh`). If you want a "cheap" probe, use `"low"`. Our Settings → Test button caught this — the probe was returning `200 OK` when targeting Chat Completions without tools, but the same key/effort combo against Responses with tools returned 400.

**Gotcha:** the reasoning panel in the UI stays blank if you don't send the `reasoning` block on every call. If a user re-prompts mid-session without thinking-mode toggled, the next request goes out without `reasoning: {...}` and the model produces a plain answer with no streaming summary. Default `reasoning_effort = "medium"` (or whatever your minimum is) on all OpenAI calls and let the caller override only if they want it OFF. See LESSONS-LEARNED 2026-05-16 for the full incident.

---

## 8. System prompts

Two big differences:

1. **Where the system prompt goes** in the request body.
2. **Self-identification.** Most system prompts say something like "You are Simorgh, an AI assistant built on Claude." When that prompt is sent to GPT-5.5 verbatim, the model dutifully refers to itself as Claude. You need a small addendum.

### Where it goes

```python
# Anthropic
client.messages.create(
    model="claude-sonnet-4-6",
    system=system_prompt,        # top-level string parameter
    messages=[...],
    ...
)

# OpenAI Responses
client.responses.create(
    model="gpt-5.5",
    instructions=system_prompt,  # top-level string parameter (NOT a message!)
    input=[...],                 # the flat input items
    ...
)
```

If you pass `system_prompt` as a message with `role: "system"` to the Responses API, the model treats it as just another input and your behavioral rules don't bind. Always use `instructions:`.

### Self-identification addendum

Keep two files:

```
agent/prompts/
├── system_prompt.md                    # canonical, Claude-flavored
└── system_prompt_addendum_openai.md    # one short paragraph overriding self-identification
```

The OpenAI loop loads both and concatenates:

```python
system_prompt = load_prompt("simorgh")  # base prompt
if is_openai_model(model):
    addendum = Path("agent/prompts/system_prompt_addendum_openai.md").read_text(encoding="utf-8")
    system_prompt = f"{system_prompt}\n\n---\n\n{addendum}"
```

A minimal addendum:

```markdown
## Provider context

You are running on OpenAI's GPT-5.5 as a fallback path while the primary
Anthropic Claude service is degraded. When users ask about your model or
provider, accurately describe yourself as running on GPT-5.5. Your
identity, role, and behavioral rules above are unchanged — only your
self-description regarding model/provider should reflect the actual
runtime.
```

Keep the addendum short. It targets exactly one behavior — self-identification — and shouldn't try to redo persona or capability instructions, which are already in the base prompt.

### Timestamp injection

Both paths should inject the current timestamp + timezone into the system prompt so the model knows what "yesterday" means. This is identical between providers:

```python
system_prompt += (
    f"\n\n---\n\n"
    f"**Current date/time:** {now_local.strftime('%Y-%m-%d %H:%M %Z')}\n"
    f"**Configured timezone:** {org.timezone} ({org.timezone_abbr})\n"
)
```

For the OpenAI path, you can additionally include a one-line note that says **"Active provider: OpenAI GPT-5.5 (fallback path)"** so the model can be honest if asked. The other team should decide if they want users to know.

---

## 9. Streaming

Both APIs support streaming via SSE. The events are differently named but the abstraction you build over them is identical.

### Anthropic events (selected)

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{...}}
```

For `thinking` deltas you get `{"type":"thinking_delta","thinking":"..."}` events between block start/stop.

### OpenAI Responses events (selected)

```
event: response.created
event: response.output_item.added         # outermost item start
event: response.content_part.added        # content part within an item
event: response.output_text.delta         # text token
event: response.reasoning_summary_text.delta   # reasoning summary token
event: response.function_call_arguments.delta  # tool call arguments streaming
event: response.output_item.done          # one full item ended
event: response.completed                 # whole response done
```

### The abstraction

Define a callback interface on your agent loop, identical for both:

```python
def run_agent_loop(
    *,
    on_token: Callable[[str], None] | None = None,           # text deltas
    on_reasoning_delta: Callable[[str], None] | None = None, # reasoning summary deltas
    on_reasoning_done: Callable[[str], None] | None = None,  # reasoning block done
    on_tool_call: Callable[[dict], None] | None = None,      # tool invoked
    on_stats: Callable[[dict], None] | None = None,          # end of iteration stats
    ...
):
```

Implement the SSE handler in each loop file. Translate the provider's events into these callbacks. The WebSocket handler and UI never need to know which provider is firing them.

---

## 10. Persistence: the provider-agnostic transcript format

Store every chat in the Anthropic-native block format. Why:

- The block format is more expressive than OpenAI's flat-item format (named content types, explicit linkages).
- Conversion Anthropic→OpenAI at request time is well-defined.
- Conversion OpenAI→Anthropic at persistence time is well-defined for everything except the `fc_*` IDs, which you carry in an extra field.

Schema (relevant columns):

```sql
CREATE TABLE chat_sessions (
    session_id TEXT PRIMARY KEY,
    model_name TEXT,           -- 'claude-sonnet-4-6' or 'gpt-5.5'
    forked_from TEXT,          -- session_id of the source if this is a fork-on-fallback
    ...
);

CREATE TABLE chat_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' | 'assistant' | 'tool_result' | 'assistant_reasoning'
    content TEXT NOT NULL,     -- JSON-encoded Anthropic-native blocks for tool/reasoning;
                               -- plain string for simple text turns
    tool_calls JSONB,          -- array of {id, openai_item_id, name, input}
    tool_result JSONB,         -- {tool_use_id, content}
    timestamp TEXT NOT NULL
);
```

Notice there is NO `provider` column on `chat_messages`. The provider is inferred from `chat_sessions.model_name`. This keeps backward compatibility with pre-failover sessions and keeps the schema simple.

When a session is forked from Anthropic to OpenAI (or vice versa), the new session row records `forked_from = <source_id>` and the new `model_name`. The messages are copied as-is — the converter handles the protocol differences at runtime.

---

## 11. Health tracking + circuit-breaker readiness

This is the foundation for both manual ("show user a banner") and automatic ("auto-route new sessions") failover.

### Schema

```sql
CREATE TABLE provider_health_events (
    id BIGSERIAL PRIMARY KEY,
    provider TEXT NOT NULL,         -- 'anthropic' | 'openai'
    success BOOLEAN NOT NULL,
    error_type TEXT,                -- 'api_error' | 'api_timeout' | 'stream_stall' | ...
    error_message TEXT,             -- truncated to 500 chars
    session_id TEXT,
    model TEXT,
    recorded_at TEXT NOT NULL       -- ISO8601 UTC
);
CREATE INDEX idx_provider_health_window
    ON provider_health_events(provider, recorded_at DESC);
```

### Recording

Every agent loop completion records one event. From `api/routes/chat.py` (the WS handler), after the loop returns:

```python
from api.services.provider_health import record as _ph_record

is_error = (
    "api_error" in result.get("stopped_reason", "")
    or "api_timeout" in result.get("stopped_reason", "")
)
try:
    _ph_record(
        db,
        provider="openai" if is_openai_model(model) else "anthropic",
        success=not is_error,
        error_type=result.get("stopped_reason", "").split(":")[0] if is_error else None,
        error_message=result.get("stopped_reason", "")[:500] if is_error else None,
        session_id=session_id,
        model=model,
    )
except Exception:
    pass  # Health tracking is fire-and-forget; never bubble back to the agent
```

The `try/except` matters: if your health DB write fails for some reason, the user's investigation must NOT crash. Health is a side observer, not a participant.

### Classification

A rolling 5-minute window with two thresholds:

```python
_WINDOW_SECONDS = 300            # 5 min lookback
_RECENT_SUCCESS_SECONDS = 60     # 1 min "still alive" window
_DEGRADED_THRESHOLD = 3          # ≥3 errors → degraded
_DOWN_THRESHOLD = 5              # ≥5 errors AND no success in 60s → down

def status(db, provider) -> Literal["healthy", "degraded", "down", "unknown"]:
    try:
        now = datetime.now(timezone.utc)
        win_start = (now - timedelta(seconds=_WINDOW_SECONDS)).isoformat()
        suc_start = (now - timedelta(seconds=_RECENT_SUCCESS_SECONDS)).isoformat()
        row = db.execute(
            "SELECT "
            "  COUNT(*) FILTER (WHERE success = FALSE) AS errs, "
            "  COUNT(*) FILTER (WHERE success = TRUE AND recorded_at >= %s) AS recent_success "
            "FROM provider_health_events "
            "WHERE provider = %s AND recorded_at >= %s",
            (suc_start, provider, win_start),
        ).fetchone()
        errs = int(row.get("errs") or 0)
        recent = int(row.get("recent_success") or 0)
        if errs >= _DOWN_THRESHOLD and recent == 0:
            return "down"
        if errs >= _DEGRADED_THRESHOLD:
            return "degraded"
        return "healthy"
    except Exception:
        return "unknown"
```

Why these thresholds:
- **degraded ≥3 errors in 5 min**: enough to show the user a "something is wrong" banner without overreacting to one flaky request.
- **down ≥5 errors + no success in 60s**: stricter, requires both volume AND absence-of-recovery. A single transient error storm won't trip "down."
- **5-minute window**: short enough to recover quickly when the provider comes back; long enough that single-request flakes don't dominate.

Tune these to your traffic. If you process 100 turns/minute, "≥5 errors in 5 min" might be too sensitive — bump it to "≥1% error rate."

### REST endpoint

```python
@router.get("/api/provider-health")
async def get_provider_health(db: Connection = Depends(get_db)):
    from api.services.provider_health import status, last_success_at
    return {
        "anthropic": {
            "status": status(db, "anthropic"),
            "last_success_at": last_success_at(db, "anthropic"),
        },
        "openai": {
            "status": status(db, "openai"),
            "last_success_at": last_success_at(db, "openai"),
        },
    }
```

The frontend polls this every ~30s.

---

## 12. UI: fork-on-fallback and the health banner

Two affordances:

1. **A banner that appears when the primary provider's status is `degraded` or `down`**. Text: "Anthropic Claude appears degraded — Try GPT-5.5 instead." Click handler: fork.
2. **A "Try GPT-5.5" button on any active chat**. Same fork action.

### Fork endpoint

```python
@router.post("/api/sessions/{session_id}/fork-to-model")
async def fork_session(session_id: str, model: str, db: Connection = Depends(get_db)):
    """Create a NEW session with the requested model and copy this
    session's full message history. Does NOT auto-resume — the analyst
    must explicitly continue in the new session."""
    src = db.execute(
        "SELECT * FROM chat_sessions WHERE session_id = %s", (session_id,)
    ).fetchone()
    if not src:
        raise HTTPException(404)

    new_id = generate_session_id()
    db.execute(
        "INSERT INTO chat_sessions (session_id, model_name, forked_from, "
        " template_id, incident_id, user_id, ...) "
        "VALUES (%s, %s, %s, ...)",
        (new_id, model, session_id, src["template_id"], ...),
    )
    db.execute(
        "INSERT INTO chat_messages (message_id, session_id, role, content, "
        " tool_calls, tool_result, timestamp) "
        "SELECT gen_random_uuid(), %s, role, content, tool_calls, tool_result, timestamp "
        "FROM chat_messages WHERE session_id = %s ORDER BY timestamp",
        (new_id, session_id),
    )
    db.commit()
    return {"session_id": new_id, "forked_from": session_id, "model_name": model}
```

### Why fork instead of swap

We considered mid-session swap: the chat continues, but the next message goes to OpenAI. We rejected it because:

- Mid-session message-format mismatches: the assistant's most recent turn might contain a `tool_use` that the user hasn't responded to yet. Mid-swap would require translating an in-flight tool call across providers, and the failure mode is "weird agent behavior on the NEXT turn" — hard to diagnose.
- Audit trail clarity: an investigator looking at a transcript should see exactly one provider per session. Mixed-provider transcripts confuse forensic review.
- ID continuity risk: the `fc_*` vs `call_*` IDs are tied to specific OpenAI response items. Swapping mid-session means the next OpenAI call starts with Anthropic-native messages that have no `fc_*` IDs — the converter has to synthesize them, and a misstep causes 400 errors.

Fork is more conservative. The user clicks once, gets a new session at the same state, and can continue. The original session stays preserved for review.

### Banner state

Drive the banner from `GET /api/provider-health`, not from regex-matching error messages in the chat. The lesson from our first attempt: we were parsing the `lastAgentError` text in the frontend to decide whether to show "Try GPT-5.5", and the error formatting drifted between Python versions, breaking the banner. The DB-authoritative health endpoint is the single source of truth.

---

## 13. Configuration surface

Minimal viable config:

| Key | Type | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` (env var) | str | unset | Checked first. |
| `openai_api_key` (agent_config row) | str | unset | Fallback if env var is missing. Stored in DB so admins can rotate without redeploying. |
| `auto_fallback_enabled` (agent_config row) | bool | false | **Phase 2.** When true, the dispatcher routes new sessions to OpenAI when `status(anthropic) == "down"`. |
| `template.allowed_models` (Python) | tuple | per template | Each chat template (e.g. "Simorgh", "Rostam") declares which models it permits. Both `claude-...` and `gpt-...` go here. |

The UI surface for Phase 1 is one panel:

```
Settings → AI → Provider Fallback
├── OpenAI API key  [_________________] [Save]  [Test]
├── Anthropic: healthy  (last success 12s ago)
└── OpenAI:    healthy  (last success 4h ago)
```

The Test button calls a probe endpoint that does a minimal Responses API round-trip:

```python
@router.post("/api/provider-health/test-openai")
async def test_openai_key(db: Connection = Depends(get_db)):
    from openai import OpenAI
    cfg = get_config(db)
    key = os.environ.get("OPENAI_API_KEY") or cfg.get("openai_api_key")
    if not key:
        return {"ok": False, "error": "OPENAI_API_KEY not configured"}
    try:
        client = OpenAI(api_key=key)
        r = client.responses.create(
            model="gpt-5.5",
            instructions="Reply with the single word OK.",
            input=[{"role": "user", "content": [{"type": "input_text", "text": "Ping."}]}],
            max_output_tokens=64,
            reasoning={"effort": "low"},   # NOT "minimal" — see gotcha #3
        )
        text = r.output_text or ""
        record(db, "openai", success=True, model="gpt-5.5")
        return {"ok": True, "model": r.model, "text": text[:80]}
    except Exception as exc:
        record(db, "openai", success=False, error_message=str(exc), model="gpt-5.5")
        return {"ok": False, "error": str(exc)}
```

**Critical:** the probe must use the **same endpoint and same parameters** as the real agent loop. Our first probe used Chat Completions without tools and returned "OK" — but the real agent path used Responses with tools and 400'd. Green probe + red agent = worse than no probe. See LESSONS-LEARNED 2026-05-16 for the full incident.

---

## 14. The nine gotchas you will hit

Field notes from the two weeks we spent stabilizing this. Read this section before you start coding.

### Gotcha 1: GPT-5.5 + function tools requires Responses API, not Chat Completions

The Chat Completions endpoint (`/v1/chat/completions`) does not accept function tools when `reasoning_effort` is set on GPT-5.x reasoning models. You'll see:

```
HTTP 400: Function tools with reasoning_effort are not supported for
gpt-5.5 in /v1/chat/completions. Please use /v1/responses instead.
```

Use the Responses API (`client.responses.create`) for all reasoning-model + tools work. The two endpoints have different request shapes (covered in section 4) — they are NOT a drop-in swap.

### Gotcha 2: Tool calls have TWO IDs, both required on replay

OpenAI Responses returns each function call with `item.id` (format `fc_...`) AND `item.call_id` (format `call_...`). On the next turn, you MUST send back the original `fc_...` in `function_call.id` AND the original `call_...` in `function_call.call_id`. If you collapse them down to one ID and use that for both slots, the second iteration returns:

```
HTTP 400: Expected an ID that begins with 'fc'.
```

Persist both. Extend your Anthropic-native `tool_use` block with an extra field (we called it `openai_item_id`) to store the `fc_...` id. Don't try to derive one from the other.

### Gotcha 3: GPT-5.5 rejects `reasoning.effort = "minimal"`

Valid values: `"low"`, `"medium"`, `"high"` (and on some models `"xhigh"`). If you pass `"minimal"` you get a 400. Use `"low"` as your minimum tier.

### Gotcha 4: Reasoning panel stays blank if you don't send `reasoning` on EVERY call

If you only attach `reasoning: {effort, summary}` on the request when the caller explicitly enabled thinking mode, then any follow-up call without it produces a response with no reasoning items. The UI's thinking panel goes silent mid-conversation.

Fix: default to `reasoning: {effort: "medium", summary: "auto"}` on every OpenAI call, and let the caller pass `None` only if they explicitly want it OFF. Configurable per template if you have a budget-sensitive flow.

### Gotcha 5: System prompt goes in `instructions`, not as a message

The Responses API expects `instructions: str` at the top level. If you put `{"role": "system", "content": ...}` in the input array, the model treats it as input data, not a system directive.

### Gotcha 6: `cache_control` markers break OpenAI

Anthropic's `cache_control: {type: "ephemeral"}` is on tool definitions and the last system message. The OpenAI Responses API doesn't have this field and will reject it. Strip cache_control during tool/message conversion.

### Gotcha 7: 272K-token cliff on GPT-5.5

GPT-5.5 doubles input cost per-session if any single request exceeds 272,000 input tokens. The price applies for the rest of the session, not just that one call. Guard your dispatcher:

```python
approx_input_tokens = sum(len(json.dumps(m, default=str)) for m in messages) // 4
if approx_input_tokens >= 250_000:
    return {
        "stopped_reason": "api_error: input near 272K cliff — refusing to send",
        "messages": messages,
    }
```

A char/4 heuristic is good enough for the guard; you're trying to refuse before crossing, not measure precisely.

### Gotcha 8: Prompt cache doesn't transfer

Anthropic's prompt cache saves ~15K tokens of system+tool preamble per call. OpenAI caches automatically on repeated prefixes but doesn't expose explicit control, and the savings are smaller in practice. Expect per-session cost to jump 20–30% on the OpenAI path. Document this so admins don't panic on the cost dashboard during an outage.

### Gotcha 9: GPT-5.5 introduces itself as Claude

If your system prompt says "You are Claude, an AI assistant made by Anthropic," GPT-5.5 dutifully copies it. Add a small addendum (one paragraph) that overrides self-identification only, leaving the rest of the prompt intact. See section 8.

---

## 15. Testing strategy

Three test categories:

### Category A: Converter unit tests (run in CI on every PR)

Test the message and tool converters in isolation against known input/output pairs. These catch shape regressions. We have 11 of these — they cover:

- Empty messages
- String content (legacy turns)
- Plain text user + assistant
- Tool use → function_call (with both IDs)
- Tool result → function_call_output
- Thinking → reasoning round-trip
- Mixed assistant content (thinking + text + tool_use)
- Mixed user content (tool_result + text follow-up)
- Cache_control stripping on tools
- Missing `openai_item_id` synthesis (legacy block compatibility)
- The full Anthropic-native ↔ OpenAI Responses round-trip

These run in < 1 second and catch ~80% of integration bugs.

### Category B: Live API smoke test (run manually + nightly)

A script that:

1. Loads a real session from staging (or a synthetic one).
2. Calls the OpenAI loop with one tool that returns a fixed string.
3. Asserts: the model invoked the tool, the tool result fed back, the second iteration produced a text answer, and the persisted blocks round-trip cleanly through the converters.

This catches **endpoint mismatches** (gotcha #1) which unit tests can't see — only a real network call to OpenAI will fail with "Function tools with reasoning_effort are not supported for gpt-5.5 in /v1/chat/completions."

### Category C: Failover drill (run quarterly)

1. Disable the Anthropic API key in dev.
2. Trigger a real investigation that would normally use Anthropic.
3. Confirm the UI banner appears within 5 minutes.
4. Click "Try GPT-5.5", complete the investigation.
5. Re-enable Anthropic, confirm the banner clears.

If your business is regulated, document this drill in your DR runbook and run it before each release.

---

## 16. Operational properties to plan around

Things to tell SREs and the on-call team before the failover is live:

1. **Per-session cost on OpenAI is 20–30% higher** due to lack of prompt cache. Pin a Settings → Token Usage dashboard so you can spot runaway costs during a real outage.

2. **Auto-investigate / scheduled jobs do NOT fall back automatically in Phase 1.** They hardcode the Anthropic model. Either (a) ship Phase 2 for autos before declaring full coverage, or (b) accept that auto-investigate pauses during outages and the queue drains when Anthropic recovers.

3. **Forks don't auto-resume.** A user has to manually click "Continue" in the new session. This is intentional — auto-resume across providers requires translating an in-flight tool call, which is risky enough that we left it for v2.

4. **Health endpoint polling.** Frontends should poll `/api/provider-health` every 30s, not every 1s. Burst polling during an outage is wasteful and the rolling window doesn't change that fast.

5. **DB connections from killed dev processes.** When the API restarts, an idle-in-transaction connection from a prior crashed process can deadlock the schema-init's idempotent `ALTER TABLE` blocks. Document the recovery:
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction' AND query_start < NOW() - INTERVAL '5 min';
   ```

6. **Test button costs money.** Each Test click does a real `responses.create` call (~$0.001). Don't put a test button in a polling loop or on a page that auto-refreshes.

7. **Streaming-stall detection.** If the OpenAI SSE stream stalls mid-response (no events for >30s), the agent should record it as `stream_stall`, not `api_timeout` — they're different failure modes and you want them distinguishable in `provider_health_events`.

---

## 17. Phase 2: automatic failover

Phase 1 is manual: the user sees a banner and chooses. Phase 2 wires the dispatcher to the health classification so new sessions auto-route to OpenAI when Anthropic is down.

Conceptually:

```python
def resolve_model_for_new_session(requested: str, db) -> str:
    """Resolve the model name for a NEW session, with auto-fallback."""
    from api.services.provider_health import status

    # If the user explicitly chose an OpenAI model, honor it.
    if is_openai_model(requested):
        return requested

    # If the user chose an Anthropic model and Anthropic is healthy, honor it.
    anth_status = status(db, "anthropic")
    if anth_status in ("healthy", "degraded"):
        return requested

    # Anthropic is down. Auto-fallback if enabled, else stay with requested
    # (will fail on first call, but at least the failure is honest).
    if not _get_bool_config(db, "auto_fallback_enabled", False):
        return requested

    # Check the auto-fallback target is healthy too — don't route to a
    # second sick provider.
    if status(db, "openai") == "down":
        return requested  # Both down, nothing we can do.

    return _get_str_config(db, "auto_fallback_model", "gpt-5.5")
```

Things to be careful about:

- **Existing sessions are not auto-switched.** A session created on Anthropic stays on Anthropic — switching mid-session is the fork problem all over again. Auto-fallback only affects NEW sessions.
- **Don't auto-flip-flop.** Add a minimum dwell time (e.g., 5 min) before auto-routing back to Anthropic after a recovery, so a flaky recovery doesn't ping-pong sessions between providers.
- **Notify the user.** When auto-fallback kicks in, surface a single banner on the new session: "This session is running on OpenAI GPT-5.5 because Anthropic Claude is currently down." Users should never be surprised by a provider switch.
- **Audit log.** Every auto-fallback event should land in your audit log with `event=auto_fallback, from=anthropic, to=openai, anthropic_status=down`.

We deferred Phase 2 because Phase 1 was already a substantial change and we wanted to bake the manual path in production before automating it.

---

## 18. Implementation checklist

Copy this into a tracking issue. Items in roughly the order to implement them.

### Foundation (sprint 1)

- [ ] Create `agent/openai_loop.py` skeleton with `is_openai_model()` and a stub `run_agent_loop_openai()` that just `raise NotImplementedError`.
- [ ] Add the dispatcher at the top of `agent/main.py:run_agent_loop`. Verify it routes correctly with a unit test (mock both loops, call `run_agent_loop(model="gpt-5.5")`, assert `run_agent_loop_openai` was called).
- [ ] Add columns to `chat_sessions`: `model_name TEXT`, `forked_from TEXT`. Backfill `model_name` for existing rows to the Anthropic default.
- [ ] Add column to assistant `tool_use` blocks at write time: `openai_item_id TEXT`. Existing rows have it NULL; the converter synthesizes a value at conversion time. No migration needed.
- [ ] Create `provider_health_events` table + indexes.
- [ ] Implement `api/services/provider_health.py` with `record()`, `status()`, `last_success_at()`.
- [ ] Wire health recording into the existing Anthropic loop's success/error paths so you have Anthropic baseline data before the OpenAI path is live.

### Converters (sprint 2)

- [ ] Implement `convert_tools_to_openai`. Unit test with cache_control present and absent.
- [ ] Implement `convert_messages_to_openai`. Unit test all branches in section 5.
- [ ] Implement `_build_anthropic_assistant_block` (the inverse). Unit test round-trip: Anthropic → OpenAI → back to Anthropic, assert blocks are equivalent.
- [ ] Write the ID-pairing tests specifically (gotcha #2): build a session with multiple tool calls, convert out, convert back, assert all `fc_*` and `call_*` IDs preserved.

### Loop body (sprint 3)

- [ ] Implement `run_agent_loop_openai`. Mirror the Anthropic loop's iteration structure: build request → stream events → collect output items → call tools → loop. Use `client.responses.create(..., stream=True)`.
- [ ] Implement the streaming event handler: translate `response.output_text.delta` → `on_token`, `response.reasoning_summary_text.delta` → `on_reasoning_delta`, etc.
- [ ] At end-of-iteration, build the Anthropic-native assistant block from the collected output items + reasoning. Persist via the existing repository function.
- [ ] Implement the 272K-token cliff guard (gotcha #7).
- [ ] Add the system_prompt addendum loader (section 8).
- [ ] Add error classification: classify exceptions/HTTP errors into `api_error`, `api_timeout`, `stream_stall`. Same taxonomy as the Anthropic path.

### Configuration + UI (sprint 4)

- [ ] Add `openai_api_key` to the agent_config table (or your equivalent).
- [ ] Update each chat template's `allowed_models` to include your OpenAI model.
- [ ] Build the `AiFallbackPanel` Settings UI: API key input + Save + Test button + health cards.
- [ ] Implement `POST /api/provider-health/test-openai`. Use the SAME endpoint and parameters as the real loop (gotcha #6 lesson).
- [ ] Implement `GET /api/provider-health`. Frontend polls every 30s.
- [ ] Build the health banner component. Show when `anthropic.status` is `degraded` or `down`.
- [ ] Implement `POST /api/sessions/{id}/fork-to-model`. Copy messages, set `forked_from`.
- [ ] Add the "Try GPT-5.5" button to chat. Click → fork → navigate to new session.

### Testing + drill (sprint 5)

- [ ] Write the 11 converter unit tests (Category A in section 15).
- [ ] Write the live smoke test script (Category B). Add to nightly CI.
- [ ] Document the manual failover drill (Category C). Run it once before launch.
- [ ] Add an audit log row for every fork event.
- [ ] Update DR runbook with the recovery commands (idle-in-transaction termination, manual session rollback if needed).

### Launch

- [ ] Ship behind a feature flag for the first week. Enable for internal users only, watch error logs.
- [ ] Document the per-session cost increase for cost-aware teams.
- [ ] Document that auto-investigate doesn't fall back (Phase 1 limitation).
- [ ] Announce the feature with the gotchas section linked.

### Phase 2 (later)

- [ ] Implement `resolve_model_for_new_session` with the auto-fallback logic in section 17.
- [ ] Add `auto_fallback_enabled` and `auto_fallback_model` config keys.
- [ ] Add the dwell-time logic (don't ping-pong on flaky recoveries).
- [ ] Wire auto-investigate / scheduled jobs through the same resolver.
- [ ] Audit log every auto-fallback event.
- [ ] Banner on auto-routed sessions explaining the switch.

---

## Appendix: file inventory from our implementation

If your team wants to grep our codebase for reference (commits `bc57cb8` → `0c6b91f`):

| File | Purpose |
|---|---|
| `agent/main.py` | Anthropic-native agent loop. Dispatcher near the top. |
| `agent/openai_loop.py` | OpenAI Responses API loop. ~990 lines. |
| `agent/prompts/system_prompt.md` | Canonical system prompt (Claude-flavored). |
| `agent/prompts/system_prompt_addendum_openai.md` | Self-identification override. |
| `api/services/provider_health.py` | Rolling-window classifier. ~160 lines. |
| `api/routes/settings.py` | `/api/provider-health` + `/api/provider-health/test-openai`. |
| `api/routes/chat.py` | WS handler. Health recording happens after each loop. |
| `api/services/chat_templates.py` | Template registry; declares `allowed_models` per template. |
| `api/database.py` | Schema: `provider_health_events`, `chat_sessions.model_name`, `chat_sessions.forked_from`. |
| `web/src/components/settings/AiFallbackPanel.tsx` | Settings UI panel. |
| `web/src/hooks/useProviderHealth.ts` | Frontend polling hook. |
| `scripts/test_openai_converters.py` | The 11 converter unit tests. |

The relevant LESSONS-LEARNED entries (in `LESSONS-LEARNED.md`):

- **2026-05-16: GPT-5.5 fallback path — operational notes** — Phase 1 design overview.
- **2026-05-16: GPT-5.5 + function tools requires Responses API, not Chat Completions** — Gotcha #1 in full.
- **2026-05-16: Tool-call ID format (fc_ vs call_) — second-turn 400** — Gotcha #2 in full.
- **2026-05-16: GPT-5.5 reasoning panel stays blank unless reasoning is sent on EVERY call** — Gotcha #4 in full.

If you find more rough edges, add them to your equivalent of LESSONS-LEARNED — this guide is current as of 2026-05-27 but the underlying APIs change.

---

*Questions or improvements: open an issue on the Simorgh repo or contact the team. The migration from Anthropic-only to dual-provider was a ~2-week project for a 2-engineer team; budget similarly for yours, with most of the time spent on the gotchas in section 14 rather than the converters in section 5.*
