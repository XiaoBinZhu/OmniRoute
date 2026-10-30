/**
 * 预扣用的提示词估算（T2.3 / N12 / N11）。
 *
 * 原实现是 `JSON.stringify(body).length / 4`：一次 2MB 的 base64 图片会被估成
 * 50 万 token，预扣金额天价 → 小余额用户被误拒。这里先把图片/base64 替换成占位，
 * 只按文本长度估算，再给每张图片加固定 1500 token。
 *
 * @module lib/nestBilling/estimate
 */

/** 每张图片的固定估算（Anthropic 官方 ≈ (w×h)/750，1500 覆盖常见截图） */
export const IMAGE_TOKEN_ESTIMATE = 1500;
/** 单个 token 约等于的字符数（中英混排经验值，偏保守） */
const CHARS_PER_TOKEN = 3.5;
/** 超过这个长度的 base64-ish 字符串一律视为二进制载荷 */
const LONG_BASE64_MIN_CHARS = 2000;

const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/=\s]+$/;
const DATA_URI_RE = /^data:[^;,]+;base64,/i;

function looksLikeBase64Payload(value: string): boolean {
  if (value.length < LONG_BASE64_MIN_CHARS) return false;
  const sample = value.slice(0, 256);
  return DATA_URI_RE.test(value) || (BASE64_PAYLOAD_RE.test(sample) && !/\s{2,}/.test(sample));
}

type StripResult = { value: unknown; images: number };

/**
 * 递归剥离图片/base64，返回"去掉二进制后的 body"与图片数量。
 * 图片计入：data URI、Anthropic `source: {type:'base64'}`、`image_url`、`type:'image'`。
 */
export function stripBinaryPayloads(input: unknown): StripResult {
  let images = 0;

  /** `insideImage`：已由图片块计入的子树，**不再**把其中的 data URI 字符串重复计一张图 */
  const walk = (value: unknown, insideImage = false): unknown => {
    if (typeof value === "string") {
      if (looksLikeBase64Payload(value)) {
        if (!insideImage) images += 1;
        return "";
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, insideImage));
    if (typeof value !== "object" || value === null) return value;

    const record = value as Record<string, unknown>;
    const isImageBlock =
      record.type === "image" ||
      record.type === "input_image" ||
      typeof record.image_url === "string" ||
      (typeof record.image_url === "object" && record.image_url !== null);
    if (isImageBlock && !insideImage) images += 1;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      out[key] = walk(item, insideImage || isImageBlock);
    }
    return out;
  };

  return { value: walk(input), images };
}

/**
 * 估算请求的 prompt tokens：文本按 `ceil(字符数 / 3.5)`，每张图固定 1500。
 * 永远至少返回 1（nest 侧按 `promptTokens > 0` 判有效）。
 */
export function estimatePromptTokens(body: unknown): number {
  const { value, images } = stripBinaryPayloads(body);
  let text = "";
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = "";
  }
  const textTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return Math.max(1, textTokens + images * IMAGE_TOKEN_ESTIMATE);
}
