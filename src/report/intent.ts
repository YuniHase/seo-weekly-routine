/**
 * 検索意図の構成分析（週次レポート D セクション）。
 *
 * 「順位も流入も伸びているのに売れない」状態を検知するための指標。
 * 流入クエリを購買ファネルの段階に分類し、購入直前層がどれだけ来ているかを見る。
 * 情報収集層ばかりが伸びていても売上にはつながらないため、クリック総数だけを
 * 追っていると気づけない。
 *
 * 季節タグはファネルと直交（「リカバリーウェア 夏 暑い」は季節=夏・意図=検討）。
 * 季節商材は稼ぎ頭のクラスタが数ヶ月で枯れるため、消長を別軸で追う。
 *
 * 分類はクエリ文字列のみで行う決定論的処理。ここで出した数値はそのまま事実として
 * 扱えるようにし、解釈（何をすべきか）とは分離する。
 */
import type { GscRow } from "../analyze/types.ts";
import { SEASON_CLUSTERS, seasonAlerts, monthsUntilPeak, type SeasonCoverage } from "../analyze/seasonality.ts";

/** ファネル段階。上から優先的にマッチさせ、1クエリ=1段階に割り当てる */
const FUNNEL: Array<{ key: string; label: string; re: RegExp }> = [
  {
    key: "buy",
    label: "購入直前（おすすめ/比較/口コミ/価格）",
    re: /おすすめ|オススメ|比較|口コミ|くちこみ|レビュー|評判|ランキング|選び方|どれが|どっち|安い|最安|セール|割引|購入|買う|通販|どこで|楽天|amazon|アマゾン/i,
  },
  {
    key: "owner",
    label: "保有者（洗濯/寿命/使い方）",
    re: /洗濯|洗い|乾燥|寿命|何年|いつ着|いつ|毎日|手入れ|たたみ|収納|買い替え/,
  },
  {
    key: "doubt",
    label: "検討・不安（効果/デメリット/合わない）",
    re: /効果|意味ない|意味あ|デメリット|メリット|着ては|合わない|ダメ|だめ|副作用|注意|嘘|本当|効かな|why|なぜ/i,
  },
  {
    key: "brand",
    label: "ブランド指名（バクネ/ベネクス等）",
    re: /バクネ|bakune|ベネクス|venex|テンシャル|tential|ブレインスリープ|brain\s*sleep|シックスパッド|sixpad|ニトリ|ワークマン|ユニクロ/i,
  },
];

/** 季節タグ（ファネルと直交）。定義とピーク月は商材プロファイル側に持つ */
const SEASONS = SEASON_CLUSTERS.map((c) => ({ key: c.key, label: c.label, re: c.re }));

interface Bucket {
  label: string;
  clicks: number;
  impressions: number;
  position: number; // Imp加重平均
  wpos: number;
}

function classify(
  rows: GscRow[],
  defs: Array<{ key: string; label: string; re: RegExp }>,
  exclusive: boolean,
): Map<string, Bucket> {
  const m = new Map<string, Bucket>();
  const put = (key: string, label: string, r: GscRow) => {
    let b = m.get(key);
    if (!b) {
      b = { label, clicks: 0, impressions: 0, position: 0, wpos: 0 };
      m.set(key, b);
    }
    b.clicks += r.clicks;
    b.impressions += r.impressions;
    b.wpos += r.position * r.impressions;
  };
  for (const r of rows) {
    let hit = false;
    for (const d of defs) {
      if (!d.re.test(r.query)) continue;
      put(d.key, d.label, r);
      hit = true;
      if (exclusive) break;
    }
    if (exclusive && !hit) put("other", "その他（一般・情報収集）", r);
  }
  for (const b of m.values()) b.position = b.impressions > 0 ? b.wpos / b.impressions : 0;
  return m;
}

const pctStr = (v: number) => `${(v * 100).toFixed(1)}%`;
const delta = (cur: number, prev: number) => {
  if (prev === 0) return cur > 0 ? "新規" : "-";
  const r = cur / prev;
  return `${r >= 1 ? "+" : ""}${((r - 1) * 100).toFixed(0)}%`;
};

/**
 * D. 検索意図の構成。
 *
 * 注意: 集計元は page+query 次元。GSCは検索回数の少ないクエリを匿名化して
 * 返さないため、ここでのクリック合計はサイト全体の実数より少ない。
 * 構成比（どの層が多いか）を見る指標であり、実数の指標ではない。
 */
export function intentSection(gscCurrent: GscRow[], gscPrevious: GscRow[]): string {
  const cur = classify(gscCurrent, FUNNEL, true);
  const prev = classify(gscPrevious, FUNNEL, true);
  const total = [...cur.values()].reduce((s, b) => s + b.clicks, 0);
  const order = [...FUNNEL.map((f) => f.key), "other"];

  const rows = order
    .filter((k) => cur.has(k))
    .map((k) => {
      const b = cur.get(k)!;
      const p = prev.get(k);
      const share = total > 0 ? b.clicks / total : 0;
      return `| ${b.label} | ${b.clicks} | ${pctStr(share)} | ${b.impressions} | ${pctStr(b.impressions > 0 ? b.clicks / b.impressions : 0)} | ${b.position.toFixed(1)} | ${delta(b.clicks, p?.clicks ?? 0)} |`;
    });

  const buy = cur.get("buy");
  const buyShare = buy && total > 0 ? buy.clicks / total : 0;
  const verdict =
    buyShare >= 0.15
      ? `購入直前層が全クリックの ${pctStr(buyShare)}。収益化の入口は確保できている。`
      : `⚠️ **購入直前層が全クリックの ${pctStr(buyShare)} しかない。** 情報収集層は集められているが、商品を検討する段階の読者が来ていない。記事内の導線（悩み→具体的な1着）を強化するか、購入直前クエリを取る記事が必要。`;

  // 季節クラスタ
  const sCur = classify(gscCurrent, SEASONS, false);
  const sPrev = classify(gscPrevious, SEASONS, false);
  // 0件の季節も必ず行として出す。「その季節の受け皿が無い」ことこそが行動のシグナルなので、
  // 該当なしで行を消すと一番重要な空白が見えなくなる。
  const month = new Date().getMonth() + 1;
  const coverage = new Map<string, SeasonCoverage>();
  const seasonRows = SEASON_CLUSTERS.map((sc) => {
    const c = sCur.get(sc.key), p = sPrev.get(sc.key);
    const clicks = c?.clicks ?? 0;
    const impressions = c?.impressions ?? 0;
    const share = total > 0 ? clicks / total : 0;
    coverage.set(sc.key, { clicks, impressions, share });
    const until = monthsUntilPeak(sc, month);
    const peak = until === 0 ? "**ピーク中**" : `あと${until}ヶ月`;
    return `| ${sc.label} | ${clicks} | ${pctStr(share)} | ${impressions} | ${delta(clicks, p?.clicks ?? 0)} | ${sc.peakMonths[0]}〜${sc.peakMonths[sc.peakMonths.length - 1]}月（${peak}） |`;
  });
  const alerts = seasonAlerts(new Date(), coverage);
  const alertLines = alerts.map((a) => `- ${a.level === "danger" ? "🚨" : "⚠️"} ${a.message}`);

  return [
    "## 🎯 検索意図の構成",
    "> 流入クエリを購買ファネルの段階に分類。クリック総数が伸びていても、購入直前層が来て",
    "> いなければ売上にはつながらないため、構成比を見る。1クエリ=1段階（上の行を優先）。",
    "> ※ GSCは検索回数の少ないクエリを匿名化するため、ここの合計はサイト全体の実数より少ない。構成比を見る指標。",
    "",
    "| 段階 | クリック | 構成比 | 表示 | CTR | 平均順位 | 前期比 |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    verdict,
    "",
    "### 季節クラスタ（ファネルと直交）",
    "> 季節商材は稼ぎ頭のクラスタが数ヶ月で枯れる。ピーク月は商材プロファイル",
    "> （`src/analyze/seasonality.ts`）の宣言値。記事は公開後すぐ上位に出ないため、",
    "> ピークの数ヶ月前に用意しておく必要がある。",
    "",
    "| 季節 | クリック | 構成比 | 表示 | 前期比 | ピーク |",
    "|---|---|---|---|---|---|",
    ...seasonRows,
    "",
    ...(alertLines.length ? ["**季節アラート**", "", ...alertLines, ""] : []),
  ].join("\n");
}

/**
 * 記事の集中度。上位n記事に流入が偏っていると、その記事が季節や順位変動で
 * 落ちたときサイト全体が落ちる。分散状況を1行で出す。
 */
export function concentrationLine(byUrl: Map<string, { clicks: number }>, topN = 5): string {
  const sorted = [...byUrl.values()].map((a) => a.clicks).sort((a, b) => b - a);
  const total = sorted.reduce((s, c) => s + c, 0);
  if (total === 0) return "";
  const top = sorted.slice(0, topN).reduce((s, c) => s + c, 0);
  const share = top / total;
  const warn = share >= 0.8 ? " ⚠️ 依存度が高く、この記事群が落ちるとサイト全体が落ちる。" : "";
  return `> 流入の集中度: 上位${topN}記事で全クリックの **${pctStr(share)}**（${top}/${total}）。${warn}\n`;
}

/**
 * E. 「高順位なのにクリックされない」クエリの検出。
 *
 * 画像枠・動画枠・強調スニペット等に載っているだけで、実質の順位ではないケース。
 * 順位が良いのにクリックが0のまま表示だけ多いクエリは、リライトで改善しても
 * クリックにつながらないことが多いため、期待値の補正として出す。
 */
export function phantomRankSection(gscCurrent: GscRow[], minImpressions = 50): string {
  const byQ = new Map<string, { clicks: number; imp: number; wpos: number; page: string }>();
  for (const r of gscCurrent) {
    const e = byQ.get(r.query) ?? { clicks: 0, imp: 0, wpos: 0, page: r.page };
    e.clicks += r.clicks;
    e.imp += r.impressions;
    e.wpos += r.position * r.impressions;
    byQ.set(r.query, e);
  }
  const hits = [...byQ.entries()]
    .map(([q, e]) => ({ q, clicks: e.clicks, imp: e.imp, pos: e.imp > 0 ? e.wpos / e.imp : 0, page: e.page }))
    .filter((r) => r.imp >= minImpressions && r.pos <= 5 && r.clicks === 0)
    .sort((a, b) => b.imp - a.imp)
    .slice(0, 10);

  if (hits.length === 0) return "";
  return [
    "## 👻 高順位なのにクリック0のクエリ",
    `> 平均順位5位以内・表示${minImpressions}以上なのにクリックが0。画像枠や強調スニペットに`,
    "> 載っているだけで実質の順位ではない可能性が高い。ここの順位改善に期待しないこと。",
    "",
    "| クエリ | 表示 | 平均順位 |",
    "|---|---|---|",
    ...hits.map((r) => `| ${r.q} | ${r.imp} | ${r.pos.toFixed(1)} |`),
    "",
  ].join("\n");
}

/**
 * F. 収益の実力値と上限の試算。
 *
 * 「導線を完璧にしたら今の流入でいくらになるか」を出す。改善作業に見合うかの判断材料。
 * アフィリエイト報酬額は取得できないため、1クリックあたりの期待報酬(EPC)は
 * 環境変数で与える前提の概算とし、断定しない。
 */
export function revenueCeilingSection(
  totalSessions: number,
  totalAffClicks: number,
  targetAffRate: number,
  epcYen: number,
): string {
  if (totalSessions === 0) return "";
  const rate = totalAffClicks / totalSessions;
  const ceilingClicks = totalSessions * targetAffRate;
  return [
    "## 🧮 収益の実力値と上限（概算）",
    "",
    `| | 現状 | 導線を最適化した場合 |`,
    "|---|---|---|",
    `| セッション | ${totalSessions} | ${totalSessions}（変わらない） |`,
    `| アフィクリック率 | ${pctStr(rate)} | ${pctStr(targetAffRate)}（サイト内上位25%の水準） |`,
    `| アフィクリック | ${totalAffClicks} | ${Math.round(ceilingClicks)} |`,
    `| 概算報酬 | ${Math.round(totalAffClicks * epcYen).toLocaleString()}円 | ${Math.round(ceilingClicks * epcYen).toLocaleString()}円 |`,
    "",
    `> EPC（1クリックあたり期待報酬）を ${epcYen}円 と仮定した概算。実報酬はASP管理画面で確認のこと。`,
    "> **導線改善だけでは上限がこの水準**。これを超えるには流入そのものを増やす必要がある。",
    "",
  ].join("\n");
}
