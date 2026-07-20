/**
 * Google Search Console API（主データ）。
 * サービスアカウントJWT認証。直近28日 と 前28日 の2本を取得（前期比較用）。
 *
 * 期間はGSCデータ遅延（§8-E）を考慮し、終端 = 実行日 - DATA_DELAY_DAYS。
 * ディメンション: page, query / 指標: clicks, impressions, ctr, position / rowLimit: 5000
 *
 * TODO(step4): googleapis の searchconsole('v1').searchanalytics.query で実装。
 */
import type { GscRow } from "../analyze/types.ts";

export interface GscPeriods {
  current: GscRow[]; // 直近28日
  previous: GscRow[]; // その前28日
}

export async function fetchGscData(): Promise<GscPeriods> {
  throw new Error("not implemented (step4)");
}
