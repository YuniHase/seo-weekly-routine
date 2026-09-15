/**
 * リライト候補の抽出（§4-1）。
 *
 *  R1: 順位≤10 かつ CTR<3% かつ Imp≥200        （露出はあるがクリックされない）
 *  R2: 前期比で平均順位が3以上悪化 かつ 前期クリック≥10（稼いでいた記事の劣化）
 *  R3: 平均順位 11〜20 かつ Imp≥300              （2ページ目→1ページ目の押し上げ）
 *  R4: セッション≥50 かつ アフィ率 < サイト平均  （流入はあるが収益導線が弱い）
 *
 * R4はR1〜R3と独立。順位・CTRが健全なせいで既存ルールに当たらないまま
 * 収益化されていない記事（例: 流入はあるがアフィリンクが機能していない記事）を拾う。
 *
 * スコア = インプレッション × 改善余地 × GA4重み（低エンゲージメント記事を優先）。
 * URL照合は aggregate 側で normalizeUrl 済み。
 */
import type { UrlAgg } from "./aggregate.ts";
import type { Ga4Row, Candidate, RewriteRule, WpPostRef, AffiliateClicks } from "./types.ts";
import type { Thresholds } from "./thresholds.ts";
import { CONFIG } from "../config.ts";

export interface RewriteResult {
  candidates: Candidate[];
  /** 各ルールが独立に閾値を通過した件数（重複カウント可） */
  counts: Record<RewriteRule, number>;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

/** GA4のengagementRateで重み付け（低エンゲージメントほど高優先） */
function gaWeight(ga4ByPath: Map<string, Ga4Row>, url: string): number {
  const g = ga4ByPath.get(pathOf(url));
  if (!g) return 1;
  return 1 + Math.max(0, 0.6 - g.engagementRate);
}

/**
 * 収益ポテンシャル（＝リライトで増やせそうなアフィリンククリック数の推定）。
 *
 * 「集客はあるが稼げていない記事」と「稼げるが集客が少ない記事」の両方を拾うため、
 * 2つのレバーを足し合わせる:
 *   ① 導線改善: 現在のセッション × (目標アフィクリック率 − 現在の率)
 *   ② 集客改善: 現在のアフィクリック率 × SEO改善で見込めるセッション増
 *      （セッション増 ≒ Imp × (目標CTR − 現在のCTR)）
 * 実売上はAmazon/楽天とも記事別に取得できないため、アフィリンククリックを代理指標とする。
 */
function revenuePotential(
  a: UrlAgg,
  ga4ByPath: Map<string, Ga4Row>,
  affByPath: Map<string, AffiliateClicks>,
  targetAffRate: number,
): { potential: number; affClicks: number; affRate: number; sessions: number } {
  const p = pathOf(a.url);
  const sessions = ga4ByPath.get(p)?.sessions ?? 0;
  const affClicks = affByPath.get(p)?.total ?? 0;
  const affRate = sessions > 0 ? affClicks / sessions : 0;

  // ① 導線改善の余地（今の流入をもっとマネタイズできる分）
  const leverFunnel = sessions * Math.max(0, targetAffRate - affRate);
  // ② 集客改善の余地（今の収益効率のまま流入が増えた分）
  const TARGET_CTR = 0.05;
  const sessionGain = a.impressions * Math.max(0, TARGET_CTR - a.ctr);
  const leverTraffic = affRate * sessionGain;

  return { potential: leverFunnel + leverTraffic, affClicks, affRate, sessions };
}

export function extractRewriteCandidates(
  current: Map<string, UrlAgg>,
  previous: Map<string, UrlAgg>,
  ga4: Ga4Row[],
  publishByUrl: Map<string, WpPostRef>,
  th: Thresholds,
  affiliate?: Map<string, AffiliateClicks>,
): RewriteResult {
  const ga4ByPath = new Map<string, Ga4Row>();
  for (const g of ga4) ga4ByPath.set(g.pagePath.replace(/\/+$/, "") || "/", g);
  const affByPath = affiliate ?? new Map<string, AffiliateClicks>();

  // 目標アフィクリック率 = サイト内の優秀な記事の水準（上位25%）。到達可能な現実的目標。
  const rates = [...current.keys()]
    .map((u) => {
      const p = pathOf(u);
      const s = ga4ByPath.get(p)?.sessions ?? 0;
      return s > 0 ? (affByPath.get(p)?.total ?? 0) / s : null;
    })
    .filter((v): v is number => v !== null && v > 0)
    .sort((a, b) => b - a);
  const targetAffRate = rates.length ? rates[Math.floor(rates.length * 0.25)] ?? rates[0] : 0;

  // サイト平均アフィクリック率。R4「導線が弱い記事」の判定基準。
  let totalAff = 0, totalSessions = 0;
  for (const [p, g] of ga4ByPath) {
    totalSessions += g.sessions;
    totalAff += affByPath.get(p)?.total ?? 0;
  }
  const siteAvgAffRate = totalSessions > 0 ? totalAff / totalSessions : 0;

  const counts: Record<RewriteRule, number> = { R1: 0, R2: 0, R3: 0, R4: 0 };
  const byUrl = new Map<string, Candidate>();
  const potentials = new Map<string, ReturnType<typeof revenuePotential>>();
  for (const [url, a] of current) potentials.set(url, revenuePotential(a, ga4ByPath, affByPath, targetAffRate));
  const maxPotential = Math.max(1e-9, ...[...potentials.values()].map((p) => p.potential));

  for (const [url, a] of current) {
    const prev = previous.get(url);
    const positionDelta = prev ? a.position - prev.position : 0; // 正=悪化
    const w = gaWeight(ga4ByPath, url);

    const hitR1 = a.position <= th.r1.maxPosition && a.ctr < th.r1.maxCtr && a.impressions >= th.r1.minImpressions;
    const hitR2 = !!prev && positionDelta >= th.r2.minPositionDrop && prev.clicks >= th.r2.minPrevClicks;
    const hitR3 = a.position >= th.r3.minPosition && a.position <= th.r3.maxPosition && a.impressions >= th.r3.minImpressions;
    // R4: 流入はあるのにアフィクリック率がサイト平均を下回る（＝収益導線が弱い）。
    // 順位・CTRが健全でも拾えるよう、R1〜R3とは独立に判定する。
    const rpForRule = potentials.get(url)!;
    const hitR4 =
      siteAvgAffRate > 0 &&
      rpForRule.sessions >= th.r4.minSessions &&
      rpForRule.affRate < siteAvgAffRate;
    if (hitR4) counts.R4++;
    if (hitR1) counts.R1++;
    if (hitR2) counts.R2++;
    if (hitR3) counts.R3++;

    // 1URL=1候補。優先度 R2(劣化) > R1(CTR改善) > R3(2ページ目)
    let rule: RewriteRule | null = null;
    let factor = 0;
    if (hitR2) {
      rule = "R2";
      factor = Math.min(1, positionDelta / Math.max(1, a.position));
    } else if (hitR1) {
      rule = "R1";
      factor = Math.max(0, (0.05 - a.ctr) / 0.05);
    } else if (hitR3) {
      rule = "R3";
      factor = Math.min(1, Math.max(0, (a.position - 10) / a.position));
    } else if (hitR4) {
      rule = "R4";
      // 導線ギャップの大きさ（目標率にどれだけ届いていないか）を改善余地とみなす
      factor = targetAffRate > 0 ? Math.min(1, Math.max(0, (targetAffRate - rpForRule.affRate) / targetAffRate)) : 0;
    }
    if (!rule) continue;

    // 収益重み: 収益ポテンシャルが大きい記事ほどスコアを押し上げる（最大 1+REVENUE_WEIGHT 倍）
    const rp = potentials.get(url)!;
    const revenueMultiplier = 1 + CONFIG.run.revenueWeight * (rp.potential / maxPotential);

    const score = Math.round(a.impressions * factor * w * revenueMultiplier * 100) / 100;
    const topQueries = a.queries.slice(0, 4).map((q) => q.query);
    const post = publishByUrl.get(url);
    const revenueNote =
      ` | 収益: アフィclick${rp.affClicks} (率${(rp.affRate * 100).toFixed(2)}%/セッション${rp.sessions})` +
      ` 伸びしろ${rp.potential.toFixed(1)}click ×${revenueMultiplier.toFixed(2)}`;
    const reason =
      `${rule} | ${url} | 順位${a.position.toFixed(1)} CTR${(a.ctr * 100).toFixed(1)}% Imp${a.impressions} クリック${a.clicks}` +
      revenueNote +
      (rule === "R2" ? ` | 前期比 順位${positionDelta >= 0 ? "+" : ""}${positionDelta.toFixed(1)}悪化(前期クリック${prev?.clicks})` : "") +
      (ga4ByPath.get(pathOf(url)) ? ` | GA4 eng${(ga4ByPath.get(pathOf(url))!.engagementRate * 100).toFixed(0)}%` : "") +
      ` | 対象クエリ: ${topQueries.map((q) => `"${q}"`).join(", ")}`;

    byUrl.set(url, {
      type: "rewrite",
      rule,
      targetUrl: url,
      wpPostId: post?.id ?? null,
      queries: topQueries,
      score,
      metrics: { position: a.position, ctr: a.ctr, impressions: a.impressions, clicks: a.clicks, positionDelta: prev ? positionDelta : undefined },
      reason,
    });
  }

  return { candidates: [...byUrl.values()], counts };
}
