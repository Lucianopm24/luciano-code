import { getApiKey, hasNvidiaDataConsent, runtimeConfig } from './config.js';
import { consumeNvidiaRequest } from './rate-limit.js';

function extractError(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed.error?.message || parsed.message || body;
  } catch {
    return body || 'Unknown provider error';
  }
}

function mergeToolDelta(toolCalls, deltas = []) {
  for (const delta of deltas) {
    const index = Number.isInteger(delta.index) ? delta.index : toolCalls.length;
    const current = toolCalls[index] || {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' },
    };
    if (delta.id) current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function?.name) current.function.name += delta.function.name;
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
    toolCalls[index] = current;
  }
}

async function readStream(response, { onToken, onReasoning, noThink = false } = {}) {
  const reader = response.body?.getReader();
  if (!reader) return { content: '', reasoning: '', toolCalls: [], usage: null };

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  const toolCalls = [];
  const streamedToolFields = new Map();
  let lastToolIndex = null;

  const consume = (line) => {
    if (!line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return payload === '[DONE]';
    try {
      const parsed = JSON.parse(payload);
      if (parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
      const choice = parsed.choices?.[0] || {};
      const delta = choice.delta || {};
      const contentToken = typeof delta.content === 'string' ? delta.content : '';
      const reasoningToken = typeof (delta.reasoning_content ?? delta.reasoning) === 'string'
        ? (delta.reasoning_content ?? delta.reasoning)
        : '';
      // NVIDIA NIM sends incremental deltas, not cumulative snapshots. Preserve
      // every fragment exactly as received so `Ho`, `la`, ` mun`, `do` remains
      // an immediate `Ho` + `la` + ` mun` + `do` stream.
      if (contentToken) {
        content += contentToken;
        onToken?.(contentToken);
      }
      if (reasoningToken) {
        reasoning += reasoningToken;
        if (!noThink) onReasoning?.(reasoningToken);
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        const normalizedDeltas = delta.tool_calls.map((toolCall) => {
          const index = Number.isInteger(toolCall.index)
            ? toolCall.index
            : (lastToolIndex ?? toolCalls.length);
          lastToolIndex = index;
          const previous = streamedToolFields.get(index) || { name: '', arguments: '' };
          const name = typeof toolCall.function?.name === 'string' ? toolCall.function.name : '';
          const args = typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : '';
          const nameDelta = name.startsWith(previous.name) ? name.slice(previous.name.length) : name;
          const argsDelta = args.startsWith(previous.arguments) ? args.slice(previous.arguments.length) : args;
          streamedToolFields.set(index, {
            name: name.startsWith(previous.name) ? name : `${previous.name}${name}`,
            arguments: args.startsWith(previous.arguments) ? args : `${previous.arguments}${args}`,
          });
          return {
            ...toolCall,
            index,
            function: {
              ...toolCall.function,
              name: nameDelta,
              arguments: argsDelta,
            },
          };
        });
        mergeToolDelta(toolCalls, normalizedDeltas);
      }
    } catch {
      // Ignore incomplete or provider-specific SSE frames.
    }
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (consume(line.trim())) {
        return {
          content,
          reasoning: noThink ? '' : reasoning,
          toolCalls: toolCalls.filter(Boolean),
          usage,
        };
      }
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
  return {
    content,
    reasoning: noThink ? '' : reasoning,
    toolCalls: toolCalls.filter(Boolean),
    usage,
  };
}

export class NvidiaNimClient {
  constructor(config) {
    this.config = runtimeConfig(config);
  }

  async complete(messages, { onToken, onReasoning, tools = [] } = {}) {
    if (!hasNvidiaDataConsent(this.config)) {
      throw new Error('NVIDIA data-sharing consent is required before sending data to NVIDIA NIM.');
    }
    const apiKey = getApiKey(this.config);
    if (!apiKey) {
      throw new Error('NVIDIA API key not configured. Run `luciano-code --setup` or `key set`.');
    }

    consumeNvidiaRequest();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    timeout.unref?.();

    try {
      // SSE remains enabled when tools are present; tool-call deltas are aggregated
      // until [DONE], while content/reasoning tokens are forwarded immediately.
      const stream = Boolean(this.config.preferences.stream && (onToken || onReasoning));
      const requestBody = {
        model: this.config.model,
        messages,
        temperature: this.config.preferences.temperature,
        max_tokens: 2048,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(this.config.preferences.noThink ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      };
      const requestOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        signal: controller.signal,
      };
      let response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        ...requestOptions,
        body: JSON.stringify(requestBody),
      });
      if (!response.ok && this.config.preferences.noThink && [400, 422].includes(response.status)) {
        await response.text();
        const compatibilityBody = { ...requestBody };
        delete compatibilityBody.chat_template_kwargs;
        consumeNvidiaRequest();
        response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          ...requestOptions,
          body: JSON.stringify(compatibilityBody),
        });
      }

      if (!response.ok) {
        const body = await response.text();
        const detail = extractError(body);
        const error = response.status === 404
          ? new Error(
            `Model "${this.config.model}" was not found by NVIDIA NIM. `
            + 'Run `models` to list available model IDs, then use `model set <model-id>`. '
            + `(${detail})`,
          )
          : new Error(`NVIDIA NIM ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
      }

      if (stream) return readStream(response, { onToken, onReasoning, noThink: this.config.preferences.noThink });
      const payload = await response.json();
      const message = payload.choices?.[0]?.message || {};
      return {
        content: message.content || '',
        reasoning: this.config.preferences.noThink ? '' : message.reasoning_content ?? message.reasoning ?? '',
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
        usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
      };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('NVIDIA NIM request timed out after 120 seconds.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels() {
    if (!hasNvidiaDataConsent(this.config)) {
      throw new Error('NVIDIA data-sharing consent is required before contacting NVIDIA NIM.');
    }
    const apiKey = getApiKey(this.config);
    if (!apiKey) {
      throw new Error('NVIDIA API key not configured. Run `setup` or `key set` first.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    timeout.unref?.();

    try {
      consumeNvidiaRequest();
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`Could not list NVIDIA NIM models (${response.status}): ${extractError(body)}`);
        error.status = response.status;
        throw error;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error('NVIDIA NIM returned an invalid model list.');
      }

      return Array.isArray(payload.data)
        ? payload.data.map((model) => model.id).filter(Boolean).sort()
        : [];
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('NVIDIA NIM model list timed out after 30 seconds.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
