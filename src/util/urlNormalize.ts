/**
 * URL正規化ユーティリティ
 *
 * 過去に locokau-shop-tool で「wwwプレフィックスによる重複チェックすり抜け」が
 * 発生した教訓から、GSCのpage URL・WPのlink・提案履歴のtarget_urlはすべて
 * この正規化を通してから比較・保存する。
 *
 * 正規化ルール:
 *  - プロトコルは https に統一
 *  - ホスト名は小文字化し、先頭の "www." を除去
 *  - 末尾スラッシュを除去（ルート "/" は保持しない → "" 扱いにせず host のみ）
 *  - クエリ文字列・フラグメントは除去（SEO対象は基本的にクリーンURLのため）
 *  - パスの末尾スラッシュのみ除去（中間のスラッシュは保持）
 */

/**
 * 比較・保存用の正規化URLを返す。
 * 解析に失敗した場合は入力を可能な範囲で正規化して返す（例外を投げない）。
 */
export function normalizeUrl(input: string): string {
  if (!input) return "";
  const raw = input.trim();
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = stripTrailingSlash(u.pathname);
    return `https://${host}${path}`;
  } catch {
    // URL解析失敗時のフォールバック
    const noProto = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    const [hostAndPath] = noProto.split(/[?#]/);
    return `https://${stripTrailingSlash(hostAndPath).toLowerCase()}`;
  }
}

/**
 * 2つのURLが正規化後に同一かどうか。
 */
export function isSameUrl(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b);
}

/**
 * 末尾スラッシュを除去する。ただし空文字やルート "/" は "" にする。
 */
function stripTrailingSlash(path: string): string {
  if (!path || path === "/") return "";
  return path.replace(/\/+$/, "");
}
