/**
 * Google Analytics Data API (GA4)（補助データ）。
 * 直近28日 / ディメンション pagePath / 指標 sessions, engagementRate, averageSessionDuration。
 * 用途: リライト優先度の重み付け（流入があるのに直帰が多い記事を優先）。
 *
 * TODO(step4): googleapis の analyticsdata('v1beta').properties.runReport で実装。
 */
import type { Ga4Row } from "../analyze/types.ts";

export async function fetchGa4Data(): Promise<Ga4Row[]> {
  throw new Error("not implemented (step4)");
}
