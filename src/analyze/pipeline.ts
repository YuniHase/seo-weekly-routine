/**
 * 候補抽出のオーケストレーション（集計→抽出→重複/却下スキップ）と、
 * 閾値感度分析（データが小さいサイト向けに、閾値を緩めた場合の件数を試算）。
 */
import { aggregateByUrl, aggregateByQuery, type UrlAgg, type QueryAgg } from "./aggregate.ts";
import { extractRewriteCandidates } from "./rewriteCandidates.ts";
import { extractNewArticleCandidates } from "./newArticleCandidates.ts";
import { filterAlreadyProposed, type DedupResult } from "./dedup.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./thresholds.ts";
import { normalizeUrl } from "../util/urlNormalize.ts";
import { CONFIG } from "../config.ts";
import type { AnalyzeInput, Candidate, RewriteRule, NewRule, WpPostRef } from "./types.ts";

export interface BuildResult {
  counts: Record<RewriteRule | NewRule, number>;
  allSorted: Candidate[]; // dedup前（スコア降順）
  dedup: DedupResult; // kept / skipped
}

function publishMap(publish: WpPostRef[]): Map<string, WpPostRef> {
  const m = new Map<string, WpPostRef>();
  for (const p of publish) m.set(normalizeUrl(p.link), p);
  return m;
}

function extractWith(
  current: Map<string, UrlAgg>,
  previous: Map<string, UrlAgg>,
  byQuery: Map<string, QueryAgg>,
  input: AnalyzeInput,
  publishByUrl: Map<string, WpPostRef>,
  homeUrl: string,
  th: Thresholds,
) {
  const rw = extractRewriteCandidates(current, previous, input.ga4, publishByUrl, th);
  const nw = extractNewArticleCandidates(byQuery, current, publishByUrl, homeUrl, th);
  return { rw, nw };
}

export function buildCandidates(input: AnalyzeInput, th: Thresholds = DEFAULT_THRESHOLDS): BuildResult {
  const current = aggregateByUrl(input.gscCurrent);
  const previous = aggregateByUrl(input.gscPrevious);
  const byQuery = aggregateByQuery(input.gscCurrent);
  const publishByUrl = publishMap(input.wp.publish);
  const homeUrl = normalizeUrl(CONFIG.wp.baseUrl);

  const { rw, nw } = extractWith(current, previous, byQuery, input, publishByUrl, homeUrl, th);
  const counts = { ...rw.counts, ...nw.counts };
  const allSorted = [...rw.candidates, ...nw.candidates].sort((a, b) => b.score - a.score);
  const dedup = filterAlreadyProposed(allSorted, input.wp);
  return { counts, allSorted, dedup };
}

// ── 閾値感度分析 ───────────────────────────────────────────────
export interface SensitivityRow {
  label: string;
  variants: Array<{ value: number | string; count: number }>;
}

/** 特定閾値を振って、対応ルールの通過件数を試算する */
export function sensitivity(input: AnalyzeInput): SensitivityRow[] {
  const current = aggregateByUrl(input.gscCurrent);
  const previous = aggregateByUrl(input.gscPrevious);
  const byQuery = aggregateByQuery(input.gscCurrent);
  const publishByUrl = publishMap(input.wp.publish);
  const homeUrl = normalizeUrl(CONFIG.wp.baseUrl);

  const countFor = (th: Thresholds) => extractWith(current, previous, byQuery, input, publishByUrl, homeUrl, th);
  const clone = (): Thresholds => JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));

  const rows: SensitivityRow[] = [];

  // R1 Imp閾値
  rows.push({
    label: "R1 Imp閾値 (既定200)",
    variants: [200, 150, 100, 50].map((v) => {
      const th = clone(); th.r1.minImpressions = v;
      return { value: v, count: countFor(th).rw.counts.R1 };
    }),
  });
  // R3 Imp閾値
  rows.push({
    label: "R3 Imp閾値 (既定300)",
    variants: [300, 200, 150, 100].map((v) => {
      const th = clone(); th.r3.minImpressions = v;
      return { value: v, count: countFor(th).rw.counts.R3 };
    }),
  });
  // R2 前期クリック閾値
  rows.push({
    label: "R2 前期クリック閾値 (既定10)",
    variants: [10, 5, 3, 1].map((v) => {
      const th = clone(); th.r2.minPrevClicks = v;
      return { value: v, count: countFor(th).rw.counts.R2 };
    }),
  });
  // N1 Imp閾値
  rows.push({
    label: "N1 クエリImp閾値 (既定100)",
    variants: [100, 50, 30, 10].map((v) => {
      const th = clone(); th.n1.minImpressions = v;
      return { value: v, count: countFor(th).nw.counts.N1 };
    }),
  });

  return rows;
}
