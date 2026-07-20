/**
 * 候補抽出・分析まわりの共有型。
 */

/** GSC 1行分（page × query の集計） */
export interface GscRow {
  page: string; // 正規化前のURL（比較時に normalizeUrl を通す）
  query: string;
  clicks: number;
  impressions: number;
  ctr: number; // 0..1
  position: number;
}

/** GA4 ページ別指標 */
export interface Ga4Row {
  pagePath: string;
  sessions: number;
  engagementRate: number; // 0..1
  averageSessionDuration: number; // 秒
}

/** WP記事の最小情報（URL→記事IDマッピング / 重複・却下判定用） */
export interface WpPostRef {
  id: number;
  link: string; // 正規化前
  title: string;
  slug: string;
  status: WpStatus;
}

export type WpStatus = "publish" | "draft" | "trash";

/**
 * WPスナップショット（投稿前に取得する既存記事の状態）。
 *  - publish: 公開済み（リライト対象の母集団 / 新規テーマの受け皿有無判定）
 *  - draft:   提案済み未レビュー（＝重複提案スキップ対象）
 *  - trash:   却下済み（＝再提案スキップ対象。ただしWPゴミ箱は既定30日で自動削除）
 */
export interface WpSnapshot {
  publish: WpPostRef[];
  draft: WpPostRef[];
  trash: WpPostRef[];
}

export type RewriteRule = "R1" | "R2" | "R3";
export type NewRule = "N1" | "N2";

/** 抽出された候補（リライト or 新規） */
export interface Candidate {
  type: "rewrite" | "new";
  rule: RewriteRule | NewRule;
  targetUrl: string | null; // リライト対象の正規化済みURL（新規はnull）
  wpPostId: number | null; // リライト対象のWP記事ID
  queries: string[];
  score: number;
  /** 生成プロンプトに渡す現状メトリクス（順位・CTR・Imp等） */
  metrics: {
    position?: number;
    ctr?: number;
    impressions?: number;
    clicks?: number;
    positionDelta?: number; // 前期比（正=悪化）
  };
  /** 提案理由の人間可読サマリー（下書きコメントブロックに埋め込む） */
  reason: string;
}

/** 候補抽出ロジックへの入力（取得済みデータ一式） */
export interface AnalyzeInput {
  gscCurrent: GscRow[];
  gscPrevious: GscRow[];
  ga4: Ga4Row[];
  /** WP記事スナップショット。publish はURL→ID対応や受け皿判定、draft/trash は重複・却下判定に使う */
  wp: WpSnapshot;
}
