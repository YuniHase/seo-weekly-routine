/**
 * リライト候補の抽出（§4-1）。
 *
 *  R1: 順位≤10 かつ CTR<3% かつ Imp≥200        （露出はあるがクリックされない）
 *  R2: 前期比で平均順位が3以上悪化 かつ 前期クリック≥10（稼いでいた記事の劣化）
 *  R3: 平均順位 11〜20 かつ Imp≥300              （2ページ目→1ページ目の押し上げ）
 *
 * スコア = インプレッション × 順位改善余地 × GA4重み（低エンゲージメント記事を優先）。
 * URL照合は aggregate 側で normalizeUrl 済み。
 */
import type { UrlAgg } from "./aggregate.ts";
import type { Ga4Row, Candidate, RewriteRule, WpPostRef } from "./types.ts";
import type { Thresholds } from "./thresholds.ts";

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

export function extractRewriteCandidates(
  current: Map<string, UrlAgg>,
  previous: Map<string, UrlAgg>,
  ga4: Ga4Row[],
  publishByUrl: Map<string, WpPostRef>,
  th: Thresholds,
): RewriteResult {
  const ga4ByPath = new Map<string, Ga4Row>();
  for (const g of ga4) ga4ByPath.set(g.pagePath.replace(/\/+$/, "") || "/", g);

  const counts: Record<RewriteRule, number> = { R1: 0, R2: 0, R3: 0 };
  const byUrl = new Map<string, Candidate>();

  for (const [url, a] of current) {
    const prev = previous.get(url);
    const positionDelta = prev ? a.position - prev.position : 0; // 正=悪化
    const w = gaWeight(ga4ByPath, url);

    const hitR1 = a.position <= th.r1.maxPosition && a.ctr < th.r1.maxCtr && a.impressions >= th.r1.minImpressions;
    const hitR2 = !!prev && positionDelta >= th.r2.minPositionDrop && prev.clicks >= th.r2.minPrevClicks;
    const hitR3 = a.position >= th.r3.minPosition && a.position <= th.r3.maxPosition && a.impressions >= th.r3.minImpressions;
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
    }
    if (!rule) continue;

    const score = Math.round(a.impressions * factor * w * 100) / 100;
    const topQueries = a.queries.slice(0, 4).map((q) => q.query);
    const post = publishByUrl.get(url);
    const reason =
      `${rule} | ${url} | 順位${a.position.toFixed(1)} CTR${(a.ctr * 100).toFixed(1)}% Imp${a.impressions} クリック${a.clicks}` +
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
