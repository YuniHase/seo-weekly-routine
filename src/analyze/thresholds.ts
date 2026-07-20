/**
 * 候補抽出の閾値（§4 初期値）。実データに対する感度分析でここを調整する。
 */
export interface Thresholds {
  r1: { maxPosition: number; maxCtr: number; minImpressions: number };
  r2: { minPositionDrop: number; minPrevClicks: number };
  r3: { minPosition: number; maxPosition: number; minImpressions: number };
  n1: { minImpressions: number };
  n2: { minClusterImpressions: number; minClusters: number; excludeIfPublishedRankWithin: number };
}

/** §4 の初期値 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  // R1: 掲載順位 ≤ 10 かつ CTR < 3% かつ Imp ≥ 200
  r1: { maxPosition: 10, maxCtr: 0.03, minImpressions: 200 },
  // R2: 前期比で平均順位が 3以上悪化 かつ 前期クリック ≥ 10
  r2: { minPositionDrop: 3, minPrevClicks: 10 },
  // R3: 平均順位 11〜20 かつ Imp ≥ 100（レビューで 300→100 に緩和。小規模サイト実態に合わせる）
  r3: { minPosition: 11, maxPosition: 20, minImpressions: 100 },
  // N1: クエリImp ≥ 100 かつ 受け皿が専用記事でない
  n1: { minImpressions: 100 },
  // N2(ヒューリスティック): 1記事に検索意図の異なるクラスタが複数。
  // Option B のカニバリ回避フィルタ: 分離候補クエリが
  //  (a) excludeIfPublishedRankWithin 位以内で表示中の公開記事、または
  //  (b) その語で流入していて記事全体順位が excludeIfPublishedRankWithin 位以内の公開記事
  // に紐づく場合は「新規ではなくリライトで対応すべき」として除外する。
  n2: { minClusterImpressions: 100, minClusters: 2, excludeIfPublishedRankWithin: 10 },
};
