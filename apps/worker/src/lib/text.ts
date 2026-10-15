/** 零宽 / 不间断空格等不可见字符，折叠为普通空格 */
const INVISIBLE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF\\u00AD\\u034F\\u00A0\\u3000]",
  "g",
);

/** 无依赖的 HTML → 纯文本（收件解析与摘要用，禁止引入 linkedom 等重依赖） */
export function htmlToText(html: string | undefined | null): string {
  return String(html || '')
    .replace(/<(script|style|head|template)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(INVISIBLE, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function previewOf(source: string, limit: number): string {
  return source.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** 正文纯文本摘要：优先纯文本，回落 html→text，截断到 limit 字符 */
export function makePreview(
  text: string | undefined | null,
  html: string | undefined | null,
  limit = 160,
): string {
  return previewOf((text && text.trim()) || htmlToText(html), limit);
}

/** 同一封信的正文文本视图，见 {@link mailText} */
export interface MailText {
  /** 纯文本优先、缺失时回落 HTML 转换结果（提码、AI 兜底、通知与转发正文的口径） */
  readonly plain: string;
  /** 与 makePreview 相同的摘要 */
  preview(limit?: number): string;
}

/**
 * HTML → 纯文本惰性转换且最多一次：大 HTML 整段转换是收件链路最重的 CPU，
 * 提码、预览、AI 兜底、通知与中转转发共用这一份结果。
 */
export function mailText(text: string, html: string): MailText {
  let converted: string | undefined;
  const htmlText = () => (converted ??= htmlToText(html));
  return {
    get plain() { return text || htmlText(); },
    preview: (limit = 160) => previewOf((text && text.trim()) || htmlText(), limit),
  };
}
