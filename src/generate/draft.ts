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
import type { AffiliateShortcode } from "../fetch/wp.ts";
import { sanitizeAffiliateCodes } from "./sanitize.ts";
import { toCocoonFaqBlocks } from "./cocoonFaq.ts";
import { log } from "../util/logger.ts";

export interface GenContext {
  originalTitle?: string; // リライト元タイトル
  originalHtml?: string; // リライト元本文
  internalLinks?: Array<{ title: string; url: string }>; // 新規記事の内部リンク候補（実リンク用にURL込み）
  affiliateCatalog?: AffiliateShortcode[]; // サイト内の実在ショートコード（挿入候補）
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

/**
 * 文字列リテラル内の生の制御文字（改行・タブ）をエスケープする。
 *
 * 記事HTMLは長文なので、モデルが contentHtml の中に生の改行をそのまま
 * 出力することがある。JSONとしては不正なため、文字列内にいるかを追跡して
 * エスケープし直す。文字列外の改行（整形用）はそのまま残す。
 */
function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = inString; // 文字列内のみエスケープ開始として扱う
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

/** JSONを頑健に抽出（コードフェンスや前後テキスト、生の制御文字が混じっても対応） */
function extractJson(text: string): Record<string, unknown> {
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("生成結果からJSONを抽出できませんでした");
  const body = s.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 生の改行等が原因のことが多い。修復して再試行する
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** 生成リクエストのparams（model/system/messages/max_tokens）を組み立てる */
export function buildGenParams(c: Candidate, ctx: GenContext) {
  const user =
    c.type === "rewrite"
      ? buildRewritePrompt(c, ctx.originalTitle ?? "", ctx.originalHtml ?? "", ctx.affiliateCatalog)
      : buildNewArticlePrompt(c, ctx.internalLinks ?? [], ctx.affiliateCatalog);
  return {
    model: CONFIG.anthropic.model,
    // 記事HTMLは長め。途中で切れて不正JSONにならないよう十分な上限を取る
    // （Batchはタイムアウト無縁・実消費分のみ課金なので上限を上げても安全）。
    max_tokens: 32000,
    // 構造化リライト(JSON出力)では思考は不要。出力予算をJSON本文に回し、
    // 思考消費でJSONが途中終了するのを防ぐ（コスト・時間も削減）。
    thinking: { type: "disabled" as const },
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
    const raw = String(obj.contentHtml ?? "");
    // カタログ外IDの創作がすり抜けた場合は機械的に除去する
    const { html: cleaned, removed } = sanitizeAffiliateCodes(raw, ctx.affiliateCatalog, ctx.originalHtml);
    if (removed.length) log.warn("カタログ外のアフィショートコードを除去", { url: c.targetUrl, removed });
    // FAQはサイト既存記事と同じ Cocoon の FAQブロックに揃える
    const { html: bodyHtml, converted } = toCocoonFaqBlocks(cleaned);
    if (converted) log.info("FAQをCocoonブロックに変換", { url: c.targetUrl, converted });
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
  const rawNew = String(obj.contentHtml ?? "");
  const { html: cleanedNew, removed: removedNew } = sanitizeAffiliateCodes(rawNew, ctx.affiliateCatalog, undefined);
  if (removedNew.length) log.warn("カタログ外のアフィショートコードを除去", { title: genTitle, removed: removedNew });
  const { html: bodyHtml, converted: convertedNew } = toCocoonFaqBlocks(cleanedNew);
  if (convertedNew) log.info("FAQをCocoonブロックに変換", { title: genTitle, converted: convertedNew });
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

/**
 * 同期生成（単発・デバッグ/USE_BATCH=false用）。
 * max_tokensが大きいとSDKが非ストリーミングを拒否する（10分タイムアウト保護）ため、
 * ストリーミングで受けて finalMessage() で完全な応答を得る。
 */
export async function generateDraftSync(c: Candidate, ctx: GenContext): Promise<GeneratedDraft> {
  if (!CONFIG.anthropic.apiKey) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
  const params = buildGenParams(c, ctx);
  const res = await client.messages.stream(params).finalMessage();
  return assembleDraft(c, ctx, textOf(res.content), {
    model: res.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  });
}
