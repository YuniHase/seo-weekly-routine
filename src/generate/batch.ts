/**
 * Batch API によるドラフト一括生成（§本番・50%オフ・非同期）。
 *
 * 週1・即時性不要のため Message Batches を使う。フロー:
 *   create（投げる）→ processing_status が "ended" になるまでポーリング（タイムアウトあり）
 *   → results をストリームで取得し custom_id で候補に対応付け。
 *
 * 1件でも失敗（errored/expired/canceled）した場合はその候補だけ結果マップに入らない
 * （呼び出し側でスキップ扱い）。
 */
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "../config.ts";
import { buildGenParams, assembleDraft, contentText, type GenContext, type GeneratedDraft } from "./draft.ts";
import { log } from "../util/logger.ts";
import type { Candidate } from "../analyze/types.ts";

export interface GenItem {
  candidate: Candidate;
  ctx: GenContext;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateDraftsBatch(items: GenItem[]): Promise<Map<number, GeneratedDraft>> {
  const out = new Map<number, GeneratedDraft>();
  if (items.length === 0) return out;
  if (!CONFIG.anthropic.apiKey) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });

  const requests = items.map((it, i) => ({
    custom_id: `draft-${i}`,
    params: buildGenParams(it.candidate, it.ctx) as Anthropic.Messages.MessageCreateParamsNonStreaming,
  }));

  let batch = await client.messages.batches.create({ requests });
  log.info("Batch投入", { id: batch.id, count: requests.length });

  const start = Date.now();
  while (batch.processing_status !== "ended") {
    if (Date.now() - start > CONFIG.batch.maxWaitMs) {
      throw new Error(`Batchがタイムアウトしました（${Math.round(CONFIG.batch.maxWaitMs / 1000)}秒）id=${batch.id} status=${batch.processing_status}`);
    }
    await sleep(CONFIG.batch.pollIntervalMs);
    batch = await client.messages.batches.retrieve(batch.id);
    log.debug("Batchポーリング", { status: batch.processing_status, counts: batch.request_counts });
  }
  log.info("Batch完了", { id: batch.id, counts: batch.request_counts });

  for await (const entry of await client.messages.batches.results(batch.id)) {
    const idx = Number(entry.custom_id.replace("draft-", ""));
    const item = items[idx];
    if (!item) continue;
    if (entry.result.type === "succeeded") {
      const msg = entry.result.message;
      try {
        out.set(idx, assembleDraft(item.candidate, item.ctx, contentText(msg.content), {
          model: msg.model,
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
        }));
      } catch (e) {
        log.error(`Batch結果の整形失敗 idx=${idx}`, e instanceof Error ? e.message : String(e));
      }
    } else {
      log.warn(`Batch生成失敗 idx=${idx} (${item.candidate.targetUrl ?? item.candidate.queries[0]})`, entry.result.type);
    }
  }
  return out;
}
