/**
 * 重複・却下判定（外部DBの代替。WordPress自身の記事ステータスで判定）。
 *
 * 判定ロジック（§2）:
 *  - リライト候補: 対象URL（正規化済み）の記事が draft に既存 → 提案済みなのでスキップ。
 *    trash に同一URLがある → 却下済みなのでスキップ。
 *  - 新規記事候補: 提案テーマ（キーワード/タイトル）が publish/draft/trash いずれかの
 *    記事タイトル・スラッグと一致または高類似 → スキップ。
 *
 * 類似判定はまずタイトル・スラッグの正規化文字列での一致・部分一致で実装（過剰に凝らない）。
 * 曖昧なものは §5 の Claude API 判断ステップに委ねる。
 *
 * URL照合は必ず normalizeUrl() を通す（www有無・末尾スラッシュのすり抜け防止）。
 *
 * 注: WPのゴミ箱は既定30日で自動完全削除されるため、30日以上前に却下したテーマは
 *     再提案されうる（README参照）。
 *
 * TODO(step5): 実装。
 */
import type { Candidate, WpSnapshot } from "./types.ts";

/**
 * WPスナップショットに照らし、既に提案済み（draft）または却下済み（trash）、
 * もしくは新規テーマが既存記事と重複する候補を除外する。
 */
export function filterAlreadyProposed(_candidates: Candidate[], _wp: WpSnapshot): Candidate[] {
  throw new Error("not implemented (step5)");
}
