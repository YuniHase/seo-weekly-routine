/**
 * 新規記事候補の抽出（§4-2）。
 *
 *  N1: クエリImp≥100 かつ 受け皿が専用記事でない（トップ/カテゴリ等）
 *  N2(ヒューリスティック): 1つの既存記事が検索意図の異なるクエリ群で流入している
 *      → 意図分離の新規記事候補。最終判断は §5 の Claude ステップに委ねる。
 *
 * 過去に提案済み/却下済みの除外は dedup.ts（WP draft/trash 照合）で行う。
 */
import type { UrlAgg, QueryAgg } from "./aggregate.ts";
import type { Candidate, NewRule, WpPostRef } from "./types.ts";
import type { Thresholds } from "./thresholds.ts";

export interface N2Excluded {
  query: string;
  impressions: number;
  publishedUrl: string;
  publishedPosition: number;
  basis: "per-query" | "article-overall"; // 除外の根拠（クエリ単位順位 / 記事全体順位）
}

export interface NewResult {
  candidates: Candidate[];
  counts: Record<NewRule, number>;
  /** 既存公開記事が上位表示中のため除外したN2（=リライトで対応すべきもの） */
  n2Excluded: N2Excluded[];
}

function isNonDedicated(topPage: string, publishByUrl: Map<string, WpPostRef>, homeUrl: string): boolean {
  if (topPage === homeUrl) return true; // トップページ
  if (/\/(category|tag|author|page)\//.test(topPage) || /\/page\/\d+$/.test(topPage)) return true;
  // 公開記事として存在するなら「専用記事あり」＝N1ではない
  return !publishByUrl.has(topPage);
}

function leadingToken(query: string): string {
  const t = query.trim().split(/\s+/)[0] ?? query.trim();
  return t;
}

export function extractNewArticleCandidates(
  byQuery: Map<string, QueryAgg>,
  current: Map<string, UrlAgg>,
  publishByUrl: Map<string, WpPostRef>,
  homeUrl: string,
  th: Thresholds,
): NewResult {
  const counts: Record<NewRule, number> = { N1: 0, N2: 0 };
  const candidates: Candidate[] = [];
  const n2Excluded: N2Excluded[] = [];

  // Option B: 分離候補クエリが「10位以内で表示中の公開記事」または「その語で流入していて
  // 記事全体順位が10位以内の公開記事」に紐づくなら、カニバリ回避のためN2から除外する。
  //  - publishedBestPos: クエリ単位の最上位順位（min per-query position）
  //  - publishedArticleOverall: そのクエリで流入する公開記事の最良の全体順位（weighted avg）
  const publishedBestPos = new Map<string, { pos: number; url: string }>();
  const publishedArticleOverall = new Map<string, { overallPos: number; url: string }>();
  for (const [url, a] of current) {
    if (!publishByUrl.has(url)) continue;
    for (const qs of a.queries) {
      const cur = publishedBestPos.get(qs.query);
      if (cur === undefined || qs.position < cur.pos) publishedBestPos.set(qs.query, { pos: qs.position, url });
      const ov = publishedArticleOverall.get(qs.query);
      if (ov === undefined || a.position < ov.overallPos) publishedArticleOverall.set(qs.query, { overallPos: a.position, url });
    }
  }

  // N1: 受け皿記事がない需要クエリ
  for (const q of byQuery.values()) {
    if (q.impressions < th.n1.minImpressions) continue;
    if (!isNonDedicated(q.topPage, publishByUrl, homeUrl)) continue;
    counts.N1++;
    candidates.push({
      type: "new",
      rule: "N1",
      targetUrl: null,
      wpPostId: null,
      queries: [q.query],
      score: Math.round(q.impressions * 100) / 100,
      metrics: { impressions: q.impressions, clicks: q.clicks },
      reason: `N1 | 受け皿記事なし | クエリ"${q.query}" Imp${q.impressions} クリック${q.clicks} | 現状の表示先: ${q.topPage}`,
    });
  }

  // N2: 1記事に意図の異なるクエリクラスタが複数
  for (const [url, a] of current) {
    if (!publishByUrl.has(url)) continue; // 既存の専用記事に限る
    const clusters = new Map<string, { imp: number; rep: string; repImp: number }>();
    for (const qs of a.queries) {
      const key = leadingToken(qs.query);
      const c = clusters.get(key) ?? { imp: 0, rep: qs.query, repImp: 0 };
      c.imp += qs.impressions;
      if (qs.impressions > c.repImp) { c.repImp = qs.impressions; c.rep = qs.query; }
      clusters.set(key, c);
    }
    const strong = [...clusters.values()].filter((c) => c.imp >= th.n2.minClusterImpressions).sort((x, y) => y.imp - x.imp);
    if (strong.length >= th.n2.minClusters) {
      const secondary = strong[1]; // 分離候補となる2番目の意図
      // Option B の二条件で除外判定（カニバリ回避）
      const th10 = th.n2.excludeIfPublishedRankWithin;
      const perQuery = publishedBestPos.get(secondary.rep);
      const overall = publishedArticleOverall.get(secondary.rep);
      const byPerQuery = !!perQuery && perQuery.pos <= th10;
      const byOverall = !!overall && overall.overallPos <= th10;
      if (byPerQuery || byOverall) {
        const basis = byPerQuery ? "per-query" : "article-overall";
        const src = byPerQuery ? perQuery! : overall!;
        const pos = byPerQuery ? perQuery!.pos : overall!.overallPos;
        n2Excluded.push({ query: secondary.rep, impressions: secondary.imp, publishedUrl: src.url, publishedPosition: pos, basis });
        continue;
      }
      counts.N2++;
      const bestNote = perQuery
        ? `既存最上位(クエリ単位): ${perQuery.url} pos${perQuery.pos.toFixed(1)}（>${th10}位・記事全体も${th10}位以内なしで受け皿不十分）`
        : "既存の上位表示なし";
      candidates.push({
        type: "new",
        rule: "N2",
        targetUrl: null,
        wpPostId: null,
        queries: [secondary.rep],
        score: Math.round(secondary.imp * 100) / 100,
        metrics: { impressions: secondary.imp },
        reason: `N2(要Claude判断) | 意図分離候補 | 元記事: ${url} | 分離候補クエリ"${secondary.rep}" 系Imp${secondary.imp} | 主意図"${strong[0].rep}"系Imp${strong[0].imp} | ${bestNote}`,
      });
    }
  }

  return { candidates, counts, n2Excluded };
}
