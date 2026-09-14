/**
 * 提案履歴の永続ストア（data/proposals.json）。
 *
 * WordPressのゴミ箱は既定で約30日後に自動完全削除されるため、提案記録（対象URL・提案日・
 * 提案時メトリクス）もそこで失われる。「いつ何をリライト提案し、効果がどうだったか」を
 * 長期に積み上げるため、リポジトリ内のJSONに追記して保持する。
 *
 * 役割分担:
 *   - WPのゴミ箱  : 再提案の抑止 + 約30日の自然なクールダウン（現行運用のまま）
 *   - このJSON     : 恒久的な提案履歴・効果測定の台帳
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../util/logger.ts";

export const HISTORY_FILE = "data/proposals.json";

export interface HistoryEntry {
  runDate: string; // 提案日 YYYY-MM-DD
  targetUrl: string; // 正規化済みURL（リライト対象）
  rule?: string; // R1/R2/R3/N1/N2
  wpDraftId?: number; // 投稿した下書きのWP記事ID
  title?: string; // 提案タイトル
  before?: { position?: number; ctr?: number; impressions?: number }; // 提案時点の数値
}

const keyOf = (e: HistoryEntry) => `${e.targetUrl}|${e.runDate}`;

export function loadHistory(file: string = HISTORY_FILE): HistoryEntry[] {
  try {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw) ? (raw as HistoryEntry[]) : [];
  } catch (e) {
    log.warn("提案履歴の読み込みに失敗（空として継続）", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[], file: string = HISTORY_FILE): void {
  const dir = dirname(file);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sorted = [...entries].sort((a, b) => (b.runDate ?? "").localeCompare(a.runDate ?? "") || a.targetUrl.localeCompare(b.targetUrl));
  writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
}

/**
 * 既存履歴に新規エントリを統合する（targetUrl + runDate で重複排除）。
 * 既存側に値がある項目は保持し、欠けている項目のみ新規側で補完する。
 */
export function mergeHistory(existing: HistoryEntry[], incoming: HistoryEntry[]): { merged: HistoryEntry[]; added: number } {
  const map = new Map<string, HistoryEntry>();
  for (const e of existing) map.set(keyOf(e), e);
  let added = 0;
  for (const inc of incoming) {
    if (!inc.targetUrl || !inc.runDate) continue;
    const k = keyOf(inc);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, inc);
      added++;
    } else {
      map.set(k, {
        ...cur,
        rule: cur.rule ?? inc.rule,
        wpDraftId: cur.wpDraftId ?? inc.wpDraftId,
        title: cur.title ?? inc.title,
        before: {
          position: cur.before?.position ?? inc.before?.position,
          ctr: cur.before?.ctr ?? inc.before?.ctr,
          impressions: cur.before?.impressions ?? inc.before?.impressions,
        },
      });
    }
  }
  return { merged: [...map.values()], added };
}
