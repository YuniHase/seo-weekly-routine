/**
 * Claude API 呼び出しによるドラフト生成（§5）。
 *
 * 出力は WP投稿フォーマット（§5-3）に整形:
 *   - タイトル: 【AI提案/リライト】元タイトル or 【AI提案/新規】生成タイトル
 *   - 本文冒頭に提案理由コメントブロック＋（R1の）タイトル案コメントを挿入
 *
 * 同期(messages.create)とBatch(messages.batches)の双方から使えるよう、
 * リクエストparams生成(buildGenParams)と結果組み立て(assembleDraft)を共通化する。
 */
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.ts";
import { buildRewritePrompt, buildNewArticlePrompt, COMPLIANCE_GUIDE } from "./prompts.ts";
import type { Candidate } from "../analyze/types.ts";

export interface GenContext {
  originalTitle?: string; // リライト元タイトル
  originalHtml?: string; // リライト元本文
  internalLinkTitles?: string[]; // 新規記事の内部リンク候補
}

export interface GeneratedDraft {
  title: string; // 【AI提案/...】プレフィックス付き
  contentHtml: string; // 提案理由コメント込みの本文HTML
  changeSummary?: string; // リライト時の変更点サマリー
  titleSuggestions?: string[]; // リライトR1のタイトル案
  metaDescription?: string; // 新規記事のメタ案
  usage: { model: string; inputTokens: number; outputTokens: number };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 提案理由コメントブロック（§5-3） */
function proposalComment(c: Candidate): string {
  const m = c.metrics;
  const state = [
    m.position !== undefined ? `順位${m.position.toFixed(1)}` : null,
    m.ctr !== undefined ? `CTR${(m.ctr * 100).toFixed(1)}%` : null,
    m.impressions !== undefined ? `Imp${m.impressions}` : null,
  ].filter(Boolean).join(" ");
  const q = c.queries;
  const qStr = q.length ? `"${q[0]}"${q.length > 1 ? ` 他${q.length - 1}件` : ""}` : "-";
  const typeLabel = c.type === "rewrite" ? `リライト(${c.rule})` : `新規(${c.rule})`;
  const target = c.targetUrl ? ` | 対象: ${c.targetUrl}` : "";
  return `<!-- SEOルーチン提案 | 実行日: ${today()} | タイプ: ${typeLabel} | 対象クエリ: ${qStr} | 現状: ${state || "-"}${target} -->`;
}

/** JSONを頑健に抽出（コードフェンスや前後テキストが混じっても対応） */
function extractJson(text: string): Record<string, unknown> {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("生成結果からJSONを抽出できませんでした");
  return JSON.parse(s.slice(start, end + 1));
}

/** 生成リクエストのparams（model/system/messages/max_tokens）を組み立てる */
export function buildGenParams(c: Candidate, ctx: GenContext) {
  const user =
    c.type === "rewrite"
      ? buildRewritePrompt(c, ctx.originalTitle ?? "", ctx.originalHtml ?? "")
      : buildNewArticlePrompt(c, ctx.internalLinkTitles ?? []);
  return {
    model: CONFIG.anthropic.model,
    max_tokens: 16000,
    system: COMPLIANCE_GUIDE,
    messages: [{ role: "user" as const, content: user }],
  };
}

/** 生成テキスト(JSON)から GeneratedDraft を組み立てる（投稿フォーマット整形込み） */
export function assembleDraft(
  c: Candidate,
  ctx: GenContext,
  rawText: string,
  usage: { model: string; inputTokens: number; outputTokens: number },
): GeneratedDraft {
  const obj = extractJson(rawText);

  if (c.type === "rewrite") {
    const titleSuggestions = Array.isArray(obj.titleSuggestions) ? (obj.titleSuggestions as unknown[]).map(String) : [];
    const changeSummary = String(obj.changeSummary ?? "");
    const bodyHtml = String(obj.contentHtml ?? "");
    const titleComment = titleSuggestions.length
      ? `\n<!-- タイトル案:\n${titleSuggestions.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}\n-->`
      : "";
    return {
      title: `【AI提案/リライト】${ctx.originalTitle ?? ""}`,
      contentHtml: `${proposalComment(c)}${titleComment}\n${bodyHtml}`,
      changeSummary,
      titleSuggestions,
      usage,
    };
  }

  // 新規
  const genTitle = String(obj.title ?? "（無題）");
  const metaDescription = String(obj.metaDescription ?? "");
  const bodyHtml = String(obj.contentHtml ?? "");
  const metaComment = metaDescription ? `\n<!-- メタディスクリプション案: ${metaDescription} -->` : "";
  return {
    title: `【AI提案/新規】${genTitle}`,
    contentHtml: `${proposalComment(c)}${metaComment}\n${bodyHtml}`,
    metaDescription,
    usage,
  };
}

export function contentText(content: Anthropic.ContentBlock[]): string {
  return content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}
const textOf = contentText;

/** 同期API（messages.create）で1件生成する（step6品質確認・単発用）。 */
export async function generateDraftSync(c: Candidate, ctx: GenContext): Promise<GeneratedDraft> {
  if (!CONFIG.anthropic.apiKey) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
  const params = buildGenParams(c, ctx);
  const res = await client.messages.create(params);
  return assembleDraft(c, ctx, textOf(res.content), {
    model: res.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  });
}
