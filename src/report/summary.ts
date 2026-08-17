/**
 * 週次レポート生成（GitHub Actions の Job Summary に出力）。
 *
 *  A. 週次SEOダイジェスト: 直近28日 vs 前28日 で、順位/クリックの増減・新規流入クエリを集計。
 *  C. リライト効果測定: AI提案の記録（対象URL・実行日・提案時メトリクス）と現在のGSC値を比較。
 *
 * 追加の保存先は不要（GSCは両期間とも取得済み、提案時メトリクスは下書き本文コメント由来）。
 * 出力は環境変数 GITHUB_STEP_SUMMARY があればそこへ追記、無ければ標準出力。
 */
import { appendFileSync } from "node:fs";
import { aggregateByUrl, aggregateByQuery } from "../analyze/aggregate.ts";
import type { GscRow } from "../analyze/types.ts";
import type { ProposalRecord } from "../fetch/wp.ts";

interface Periods {
  current: { startDate: string; endDate: string };
  previous: { startDate: string; endDate: string };
}

function path(url: string): string {
  try { return new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { return url; }
}
const pct = (v?: number) => (v === undefined ? "-" : `${(v * 100).toFixed(1)}%`);
const pos = (v?: number) => (v === undefined ? "-" : v.toFixed(1));
const arrow = (delta: number, betterWhenPositive = true) => {
  if (Math.abs(delta) < 0.05) return "→";
  const good = betterWhenPositive ? delta > 0 : delta < 0;
  return good ? "🟢" : "🔴";
};

/** A. SEOダイジェスト */
function seoDigest(gscCurrent: GscRow[], gscPrevious: GscRow[]): string {
  const cur = aggregateByUrl(gscCurrent);
  const prev = aggregateByUrl(gscPrevious);
  type Row = { path: string; dPos: number; curPos: number; prevPos: number; dClicks: number; curClicks: number; imp: number };
  const rows: Row[] = [];
  for (const [url, a] of cur) {
    const p = prev.get(url);
    if (!p) continue;
    rows.push({ path: path(url), dPos: p.position - a.position, curPos: a.position, prevPos: p.position, dClicks: a.clicks - p.clicks, curClicks: a.clicks, imp: a.impressions });
  }
  const weight = (r: Row) => r.dPos * Math.log10(r.imp + 10);
  const up = rows.filter((r) => r.dPos > 0.3).sort((a, b) => weight(b) - weight(a)).slice(0, 5);
  const down = rows.filter((r) => r.dPos < -0.3).sort((a, b) => weight(a) - weight(b)).slice(0, 5);
  const clicksUp = rows.filter((r) => r.dClicks > 0).sort((a, b) => b.dClicks - a.dClicks).slice(0, 5);
  const clicksDown = rows.filter((r) => r.dClicks < 0).sort((a, b) => a.dClicks - b.dClicks).slice(0, 5);

  const curQ = aggregateByQuery(gscCurrent);
  const prevQ = aggregateByQuery(gscPrevious);
  const newQ = [...curQ.values()].filter((q) => !prevQ.has(q.query) && q.impressions >= 50).sort((a, b) => b.impressions - a.impressions).slice(0, 10);

  const posTable = (title: string, list: Row[]) =>
    `#### ${title}\n` +
    (list.length
      ? "| 記事 | 順位 (前→今) | クリック(今) | Imp(今) |\n|---|---|---|---|\n" +
        list.map((r) => `| \`${r.path}\` | ${pos(r.prevPos)} → ${pos(r.curPos)} (${r.dPos >= 0 ? "+" : ""}${r.dPos.toFixed(1)}) | ${r.curClicks} | ${r.imp} |`).join("\n")
      : "_該当なし_") + "\n";

  const clicksTable = (title: string, list: Row[]) =>
    `#### ${title}\n` +
    (list.length
      ? "| 記事 | クリック増減 | Imp(今) |\n|---|---|---|\n" +
        list.map((r) => `| \`${r.path}\` | ${r.dClicks >= 0 ? "+" : ""}${r.dClicks} | ${r.imp} |`).join("\n")
      : "_該当なし_") + "\n";

  const newQTable =
    "#### 新しく流入し始めたクエリ（前期になく Imp≥50）\n" +
    (newQ.length
      ? "| クエリ | Imp | 表示先 |\n|---|---|---|\n" +
        newQ.map((q) => `| ${q.query} | ${q.impressions} | \`${path(q.topPage)}\` |`).join("\n")
      : "_該当なし_") + "\n";

  return [
    "## 📈 週次SEOダイジェスト",
    posTable("🟢 順位が上がった記事 Top5", up),
    posTable("🔴 順位が下がった記事 Top5", down),
    clicksTable("クリック増加 Top5", clicksUp),
    clicksTable("クリック減少 Top5", clicksDown),
    newQTable,
  ].join("\n");
}

/** C. リライト効果測定（提案時 vs 現在） */
function rewriteEffect(gscCurrent: GscRow[], records: ProposalRecord[]): string {
  const cur = aggregateByUrl(gscCurrent);
  // 同一URLは最新の提案（runDate最大）を採用
  const byUrl = new Map<string, ProposalRecord>();
  for (const r of records) {
    if (!r.targetUrl) continue;
    const ex = byUrl.get(r.targetUrl);
    if (!ex || (r.runDate ?? "") > (ex.runDate ?? "")) byUrl.set(r.targetUrl, r);
  }
  const statusLabel = (s: string) => (s === "draft" ? "未レビュー" : s === "trash" ? "却下" : "採用/公開");
  const list = [...byUrl.values()].sort((a, b) => (b.runDate ?? "").localeCompare(a.runDate ?? ""));

  if (list.length === 0) return "## 🛠 リライト効果測定\n_まだ提案記録がありません_\n";

  const rows = list.map((r) => {
    const a = cur.get(r.targetUrl!);
    const bPos = r.before.position, aPos = a?.position;
    const bCtr = r.before.ctr, aCtr = a?.ctr;
    const bImp = r.before.impressions, aImp = a?.impressions;
    const dPos = bPos !== undefined && aPos !== undefined ? bPos - aPos : undefined; // 正=改善
    const dCtr = bCtr !== undefined && aCtr !== undefined ? aCtr - bCtr : undefined;
    const posCell = `${pos(bPos)} → ${pos(aPos)} ${dPos !== undefined ? arrow(dPos) : ""}`;
    const ctrCell = `${pct(bCtr)} → ${pct(aCtr)} ${dCtr !== undefined ? arrow(dCtr) : ""}`;
    const impCell = `${bImp ?? "-"} → ${aImp ?? "-"}`;
    return `| \`${path(r.targetUrl!)}\` | ${r.runDate ?? "-"} | ${statusLabel(r.status)} | ${posCell} | ${ctrCell} | ${impCell} |`;
  });

  return [
    "## 🛠 リライト効果測定（提案時 → 現在）",
    "> 順位/CTRは提案本文に記録した提案時点の値と、現在のGSC値の比較。🟢=改善 🔴=悪化。",
    "> ※ リライトが実際に反映（公開）されたかは運用に依存。「却下」は不採用、「未レビュー」は下書き待ちを表す。",
    "",
    "| 記事 | 提案日 | 状態 | 平均順位 | CTR | Imp |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function buildWeeklyReport(gscCurrent: GscRow[], gscPrevious: GscRow[], periods: Periods, records: ProposalRecord[]): string {
  return [
    `# 週次レポート（${periods.current.startDate}〜${periods.current.endDate}）`,
    `対象サイト分析: 直近28日 vs 前28日（${periods.previous.startDate}〜${periods.previous.endDate}）`,
    "",
    seoDigest(gscCurrent, gscPrevious),
    "",
    rewriteEffect(gscCurrent, records),
  ].join("\n");
}

/** GitHub Actions の Job Summary（GITHUB_STEP_SUMMARY）へ追記。無ければ標準出力。 */
export function writeReport(markdown: string): void {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (p) {
    appendFileSync(p, markdown + "\n");
  } else {
    console.log("\n" + markdown + "\n");
  }
}
