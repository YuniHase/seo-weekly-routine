/**
 * 週次レポート生成（GitHub Actions の Job Summary に出力）。
 *
 *  A. 週次SEOダイジェスト: 直近28日 vs 前28日 で、順位/クリックの増減・新規流入クエリを集計。
 *  C. リライト効果測定: 提案履歴（data/proposals.json）と現在のGSC値を比較。
 *
 * 効果測定の台帳は履歴JSON。WPのゴミ箱は約30日で自動削除されるため、WPは「現在の状態
 * （未レビューか否か）」の参照元としてのみ使う。
 * 出力は環境変数 GITHUB_STEP_SUMMARY があればそこへ追記、無ければ標準出力。
 */
import { appendFileSync } from "node:fs";
import { aggregateByUrl, aggregateByQuery } from "../analyze/aggregate.ts";
import { intentSection, phantomRankSection, revenueCeilingSection, concentrationLine } from "./intent.ts";
import { CONFIG } from "../config.ts";
import type { GscRow, WpStatus, Ga4Row, AffiliateClicks } from "../analyze/types.ts";
import type { HistoryEntry } from "../history/store.ts";

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
function seoDigest(gscCurrent: GscRow[], gscPrevious: GscRow[], curPages?: GscRow[], prevPages?: GscRow[]): string {
  const cur = aggregateByUrl(gscCurrent, curPages);
  const prev = aggregateByUrl(gscPrevious, prevPages);
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
    concentrationLine(cur),
    posTable("🟢 順位が上がった記事 Top5", up),
    posTable("🔴 順位が下がった記事 Top5", down),
    clicksTable("クリック増加 Top5", clicksUp),
    clicksTable("クリック減少 Top5", clicksDown),
    newQTable,
  ].join("\n");
}

/** C. リライト効果測定（提案時 vs 現在）。台帳は履歴JSON、WPは現在の状態の参照元。 */
function rewriteEffect(gscCurrent: GscRow[], history: HistoryEntry[], statusByUrl: Map<string, WpStatus>, curPages?: GscRow[]): string {
  const cur = aggregateByUrl(gscCurrent, curPages);
  // 同一URLは最新の提案（runDate最大）を代表として表示
  const byUrl = new Map<string, HistoryEntry>();
  for (const r of history) {
    if (!r.targetUrl) continue;
    const ex = byUrl.get(r.targetUrl);
    if (!ex || (r.runDate ?? "") > (ex.runDate ?? "")) byUrl.set(r.targetUrl, r);
  }
  // WPに下書きとして残っていれば未レビュー。ゴミ箱/30日経過で削除済みは「対応済み」。
  const statusLabel = (url: string) => (statusByUrl.get(url) === "draft" ? "未レビュー" : "対応済み");
  const list = [...byUrl.values()].sort((a, b) => (b.runDate ?? "").localeCompare(a.runDate ?? ""));

  if (list.length === 0) return "## 🛠 リライト効果測定\n_まだ提案記録がありません_\n";

  const rows = list.map((r) => {
    const a = cur.get(r.targetUrl);
    const bPos = r.before?.position, aPos = a?.position;
    const bCtr = r.before?.ctr, aCtr = a?.ctr;
    const bImp = r.before?.impressions, aImp = a?.impressions;
    const dPos = bPos !== undefined && aPos !== undefined ? bPos - aPos : undefined; // 正=改善
    const dCtr = bCtr !== undefined && aCtr !== undefined ? aCtr - bCtr : undefined;
    const posCell = `${pos(bPos)} → ${pos(aPos)} ${dPos !== undefined ? arrow(dPos) : ""}`;
    const ctrCell = `${pct(bCtr)} → ${pct(aCtr)} ${dCtr !== undefined ? arrow(dCtr) : ""}`;
    const impCell = `${bImp ?? "-"} → ${aImp ?? "-"}`;
    return `| \`${path(r.targetUrl)}\` | ${r.runDate ?? "-"} | ${statusLabel(r.targetUrl)} | ${posCell} | ${ctrCell} | ${impCell} |`;
  });

  return [
    "## 🛠 リライト効果測定（提案時 → 現在）",
    "> 順位/CTRは提案時に記録した値と、現在のGSC値の比較。🟢=改善 🔴=悪化。",
    "> ※ 状態: 「未レビュー」=WPに下書きとして残存 / 「対応済み」=リライト反映後にゴミ箱へ（30日経過で自動削除済みも含む）。",
    "> ※ 履歴は `data/proposals.json` に永続化。WPのゴミ箱が30日で消えても記録は残ります。",
    "",
    "| 記事 | 提案日 | 状態 | 平均順位 | CTR | Imp |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

/** B. 収益（アフィリエイトリンククリック）セクション */
function revenueSection(gscCurrent: GscRow[], ga4: Ga4Row[], affiliate: Map<string, AffiliateClicks>, curPages?: GscRow[]): string {
  if (affiliate.size === 0) return "## 💰 収益（アフィリンククリック）\n_計測データがありません_\n";
  const cur = aggregateByUrl(gscCurrent, curPages);
  const impByPath = new Map<string, number>();
  for (const [url, a] of cur) impByPath.set(path(url), a.impressions);
  const sessByPath = new Map<string, number>();
  for (const g of ga4) sessByPath.set(g.pagePath.replace(/\/+$/, "") || "/", g.sessions);

  const rows = [...affiliate.entries()]
    .map(([p, c]) => {
      const sessions = sessByPath.get(p) ?? 0;
      return { p, ...c, sessions, imp: impByPath.get(p) ?? 0, rate: sessions > 0 ? c.total / sessions : 0 };
    })
    .sort((a, b) => b.total - a.total);
  const totalClicks = rows.reduce((s, r) => s + r.total, 0);
  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);

  return [
    "## 💰 収益（アフィリンククリック）",
    `> 期間内の合計 **${totalClicks}クリック**（Amazon ${rows.reduce((s, r) => s + r.amazon, 0)} / 楽天 ${rows.reduce((s, r) => s + r.rakuten, 0)}）。`,
    "> ※ GA4の外部リンククリック計測。実売上ではなく収益の代理指標（Amazon/楽天とも記事別の実売上APIが無いため）。",
    "> 「率」= アフィクリック ÷ セッション。率が低く流入が多い記事＝**導線改善の余地**、率が高く流入が少ない記事＝**集客強化の余地**。",
    "",
    "| 記事 | Amazon | 楽天 | 計 | セッション | 率 | GSC Imp |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| \`${r.p}\` | ${r.amazon} | ${r.rakuten} | **${r.total}** | ${r.sessions} | ${(r.rate * 100).toFixed(1)}% | ${r.imp} |`),
    `| **合計** | | | **${totalClicks}** | ${totalSessions} | ${totalSessions ? ((totalClicks / totalSessions) * 100).toFixed(1) : "0.0"}% | |`,
    "",
  ].join("\n");
}

export function buildWeeklyReport(
  gscCurrent: GscRow[],
  gscPrevious: GscRow[],
  periods: Periods,
  history: HistoryEntry[],
  statusByUrl: Map<string, WpStatus>,
  ga4: Ga4Row[] = [],
  affiliate: Map<string, AffiliateClicks> = new Map(),
  gscCurrentPages?: GscRow[],
  gscPreviousPages?: GscRow[],
): string {
  // 収益上限の概算に使う実績値
  const sessByPath = new Map<string, number>();
  for (const g of ga4) sessByPath.set(g.pagePath.replace(/\/+$/, "") || "/", g.sessions);
  const totalSessions = [...sessByPath.values()].reduce((s, v) => s + v, 0);
  const totalAffClicks = [...affiliate.values()].reduce((s, a) => s + a.total, 0);
  // 目標率 = サイト内上位25%の水準（候補抽出側と同じ考え方）
  const rates = [...sessByPath.entries()]
    .map(([p, s]) => (s > 0 ? (affiliate.get(p)?.total ?? 0) / s : 0))
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  const targetAffRate = rates.length ? rates[Math.floor(rates.length * 0.25)] ?? rates[0] : 0;

  return [
    `# 週次レポート（${periods.current.startDate}〜${periods.current.endDate}）`,
    `対象サイト分析: 直近28日 vs 前28日（${periods.previous.startDate}〜${periods.previous.endDate}）`,
    "",
    revenueSection(gscCurrent, ga4, affiliate, gscCurrentPages),
    "",
    revenueCeilingSection(totalSessions, totalAffClicks, targetAffRate, CONFIG.run.affiliateEpcYen),
    "",
    intentSection(gscCurrent, gscPrevious),
    "",
    phantomRankSection(gscCurrent),
    "",
    seoDigest(gscCurrent, gscPrevious, gscCurrentPages, gscPreviousPages),
    "",
    rewriteEffect(gscCurrent, history, statusByUrl, gscCurrentPages),
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
