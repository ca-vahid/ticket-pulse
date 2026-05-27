# GPT-5.5 Integration Guide

## Overview

The auto-response pipeline now uses **GPT-5.5** across both classification and response generation. GPT-5.5 is called through the **Responses API**, which replaces the legacy Chat Completions API. Key differences:

- No `temperature`, `top_p`, or `logprobs` parameters.
- New controls: `reasoning.effort`, `text.verbosity`, and `max_output_tokens`.
- Uses the current default GPT-5.5 model (`gpt-5.5`). Do not expose `gpt-5.5-pro` unless the cost profile is explicitly approved.

## Runtime Controls (UI)

The legacy main Settings LLM Configuration panel is currently disabled. Runtime model selection is managed through the assignment provider settings while this surface is being rebuilt.

| Setting | Description | Default |
| --- | --- | --- |
| Model | OpenAI model used for classification and responses | `gpt-5.5` |
| Reasoning Effort | How much “thinking” GPT-5.5 performs (`none`, `low`, `medium`, `high`) | `none` |
| Verbosity | Response length/detail (`low`, `medium`, `high`) | `medium` |
| Max Output Tokens | Upper limit for Responses API output (100-4000) | `800` |

Changes are stored in the draft config; publish to activate.

## Backend Behavior

- `llmService` now calls `openai.responses.create(...)` for both classification and response generation.
- Requests include:
  ```json
  {
    "model": "gpt-5.5",
    "input": [
      { "role": "system", "content": "..." },
      { "role": "user", "content": "..." }
    ],
    "reasoning": { "effort": "none" },
    "text": {
      "verbosity": "medium",
      "format": { "type": "json_object" }
    },
    "max_output_tokens": 800
  }
  ```
- Responses are parsed via `response.output_text` and include usage metadata for token accounting.

## Migration Notes

1. **No temperature/top_p**: GPT-5.5 ignores these. Use reasoning or verbosity instead.
2. **Chain-of-thought**: The Responses API automatically maintains internal CoT between turns; we currently run single-shot interactions.
3. **Tooling**: GPT-5.5 supports tool calling. We currently send plain text prompts for auto-response JSON calls and use tool calls through the provider gateway where required.
4. **Token limits**: Keep `max_output_tokens` under 4k. Classification requests clamp to 600 tokens internally (enough for JSON output).

## Troubleshooting

- **"Unknown model"**: Ensure the selected model exists in your OpenAI account. Defaults to `gpt-5.5`.
- **Slow responses**: Increase `reasoning.effort` only when necessary; `medium` and `high` can exceed 30 seconds.
- **Oversized responses**: Lower `verbosity` or `max_output_tokens`.
- **API errors**: Responses API errors return via `error.response?.data`. The Test Auto-Response page logs them to the console for debugging.
- **Legacy parameters**: If you see `Unsupported parameter: 'response_format'`, ensure the request uses `text.format` per the Responses API requirements.

## Extending Further

- Add per-task models only after approval of the cost and quality tradeoff.
- Extend GPT-5.5 tool-calling controls by adding a “Tools” editor to the rebuilt runtime tab.
- Surface reasoning effort adjustments directly on the Test Auto-Response page for quick experimentation.

Keep this guide updated as OpenAI releases new GPT-5.x features or API requirements change.

