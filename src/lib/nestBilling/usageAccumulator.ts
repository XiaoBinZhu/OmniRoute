/**
 * 计费用量累加器（T2.3）。
 *
 * 背景（P1-3 / N3 / N12）：
 *  - Anthropic 流里 `message_start.message.usage` 带 input/cache，`message_delta.usage`
 *    往往只有 output；原来"最后一个 usage 覆盖"会把 prompt 覆盖成 0（少计输入）。
 *  - OpenAI `prompt_tokens` 已包含缓存，必须标记 `promptIncludesCache`，否则缓存
 *    被按 prompt 与 cacheRead 各计一次（多计）。
 *  - OpenAI Responses 的 usage 也是 `input_tokens/output_tokens`，但含缓存，靠
 *    `input_tokens_details.cached_tokens` 区分——不能只看字段名判口径。
 *  - 慢路径（已发 keepalive）后上游失败只写 error 帧、HTTP 仍是 200，需要按失败结算。
 *
 * 合并语义：流里的 usage 是累计量，逐事件取 **max** 对"重复全量"和"增量"都安全；
 * `total` 例外——由 prompt + completion 相加（矩阵 #12）。
 *
 * @module lib/nestBilling/usageAccumulator
 */

export interface AccumulatedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  cacheWrite1hTokens: number;
  /** true = promptTokens 已包含缓存（OpenAI 口径），nest 计价需先扣除 cacheRead */
  promptIncludesCache: boolean;
  /** 是否见过任何 usage（决定走真实用量还是估算） */
  seen: boolean;
  /** 流里出现过的错误帧（N3） */
  upstreamError: { status: number; message: string } | null;
  /** 已输出的内容字符数（中断估算用） */
  contentChars: number;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 上游错误帧识别（OpenAI `{"error":…}` / Anthropic `type:"error"`） */
function readErrorFrame(obj: Record<string, unknown>): { status: number; message: string } | null {
  const looksLikeError = obj.error !== undefined || obj.type === "error" || obj.event === "error";
  if (!looksLikeError) return null;
  const error = isRecord(obj.error) ? obj.error : null;
  const nested = error && isRecord(error.error) ? error.error : null;
  const message =
    (typeof error?.message === "string" && error.message) ||
    (typeof nested?.message === "string" && nested.message) ||
    (typeof obj.message === "string" && obj.message) ||
    "upstream error";
  const code =
    num(error?.status) || num(error?.code) || num(nested?.status) || num(obj.status) || 0;
  return { status: code >= 400 && code <= 599 ? code : 502, message };
}

/** 从各协议增量里取"新流出的内容"（N12：Claude text/thinking/tool 参数） */
function collectContent(obj: Record<string, unknown>): { chars: number; text: string } {
  let text = "";
  const push = (value: unknown) => {
    if (typeof value === "string" && value) text += value;
  };
  const delta = isRecord(obj.delta) ? obj.delta : null;
  if (delta) {
    push(delta.text);
    push(delta.thinking);
    push(delta.partial_json);
    push(delta.reasoning_content);
    push(delta.content);
  }
  const choices = Array.isArray(obj.choices) ? obj.choices : null;
  if (choices) {
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const choiceDelta = isRecord(choice.delta) ? choice.delta : null;
      if (choiceDelta) {
        push(choiceDelta.content);
        push(choiceDelta.reasoning_content);
      }
      const message = isRecord(choice.message) ? choice.message : null;
      if (message) push(message.content);
      push(choice.text);
    }
  }
  // 非流式 Anthropic：message.content[] 里的 text/thinking
  const message = isRecord(obj.message) ? obj.message : null;
  if (message && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      push(part.text);
      push(part.thinking);
    }
  }
  return { chars: text.length, text };
}

export class UsageAccumulator {
  private prompt = 0;
  private completion = 0;
  private cacheRead = 0;
  private cacheWrite5m = 0;
  private cacheWrite1h = 0;
  private openAiShape = false;
  private claudeShape = false;
  private seenUsage = false;
  private error: { status: number; message: string } | null = null;
  private chars = 0;
  private text = "";
  /** 内容文本上限（防止长流把内存拉满）；超出后只计字符数 */
  private static readonly TEXT_CAP = 512_000;

  /** 喂一个 JSON 事件（SSE data 或非流式 body） */
  feed(obj: unknown): void {
    if (!isRecord(obj)) return;

    const frameError = readErrorFrame(obj);
    if (frameError && !this.error) this.error = frameError;

    const content = collectContent(obj);
    this.chars += content.chars;
    if (content.text && this.text.length < UsageAccumulator.TEXT_CAP) {
      this.text += content.text.slice(0, UsageAccumulator.TEXT_CAP - this.text.length);
    }

    const usage = isRecord(obj.usage)
      ? obj.usage
      : isRecord(obj.message) && isRecord(obj.message.usage)
        ? obj.message.usage
        : isRecord(obj.response) && isRecord(obj.response.usage)
          ? obj.response.usage
          : null;
    if (!usage) return;

    const promptDetails = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : null;
    const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
    const creation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
    const hasClaudeCacheFields =
      usage.cache_read_input_tokens !== undefined ||
      usage.cache_creation_input_tokens !== undefined ||
      creation !== null;

    // 口径判定（N12）：有 *_details → OpenAI 口径（prompt 含缓存）；
    // 有 cache_read_input_tokens / cache_creation* 且没有 details → Claude 口径。
    if (promptDetails || inputDetails || usage.prompt_tokens !== undefined) {
      this.openAiShape = true;
    } else if (hasClaudeCacheFields) {
      this.claudeShape = true;
    }

    const prompt = num(usage.prompt_tokens) || num(usage.input_tokens);
    const completion = num(usage.completion_tokens) || num(usage.output_tokens);
    const cacheRead =
      num(usage.cache_read_input_tokens) ||
      num(usage.cache_read_tokens) ||
      num(promptDetails?.cached_tokens) ||
      num(inputDetails?.cached_tokens);

    // 5m/1h：对象形态优先；否则总和记 5m，1h 记 0（不再读非标准字段叠加）
    let write5m = 0;
    let write1h = 0;
    if (creation) {
      write5m = num(creation.ephemeral_5m_input_tokens);
      write1h = num(creation.ephemeral_1h_input_tokens);
    } else {
      write5m = num(usage.cache_creation_input_tokens);
    }

    if (prompt || completion || cacheRead || write5m || write1h) this.seenUsage = true;
    this.prompt = Math.max(this.prompt, prompt);
    this.completion = Math.max(this.completion, completion);
    this.cacheRead = Math.max(this.cacheRead, cacheRead);
    this.cacheWrite5m = Math.max(this.cacheWrite5m, write5m);
    this.cacheWrite1h = Math.max(this.cacheWrite1h, write1h);
  }

  /** 标记上游错误（由 SSE 的 `event: error` 行携带） */
  markError(status = 502, message = "upstream error"): void {
    if (!this.error) this.error = { status, message };
  }

  /** 已流出的内容文本（中断估算用；受 TEXT_CAP 限制） */
  contentText(): string {
    return this.text;
  }

  result(): AccumulatedUsage {
    const promptIncludesCache =
      this.openAiShape && !this.claudeShape
        ? this.cacheRead > 0 || this.cacheWrite5m > 0 || this.cacheWrite1h > 0
        : false;
    return {
      promptTokens: this.prompt,
      completionTokens: this.completion,
      totalTokens: this.prompt + this.completion,
      cacheWriteTokens: this.cacheWrite5m,
      cacheReadTokens: this.cacheRead,
      cacheWrite1hTokens: this.cacheWrite1h,
      promptIncludesCache,
      seen: this.seenUsage,
      upstreamError: this.error,
      contentChars: this.chars,
    };
  }
}
