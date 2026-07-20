/**
 * WordPress REST API クライアント（アプリケーションパスワード / Basic認証）。
 *
 * 状態管理に外部DBを持たないため、提案履歴・重複・却下の判定は WordPress 自身の
 * 記事ステータス（publish/draft/trash）を読んで行う（§2）:
 *  - GET /wp-json/wp/v2/posts?status=publish&per_page=100&_fields=id,link,title,slug
 *  - GET /wp-json/wp/v2/posts?status=draft&per_page=100&_fields=id,link,title,slug（要認証）
 *  - GET /wp-json/wp/v2/posts?status=trash&per_page=100&_fields=id,link,title,slug（要認証）
 *  - GET /wp-json/wp/v2/posts/{id}?context=edit … リライト対象の本文取得（要認証）
 *  - POST /wp-json/wp/v2/posts … 下書き投稿（status: draft）。提案メタは本文冒頭のHTMLコメントに埋め込む
 *
 * 疎通確認（step3）: GET /wp-json/wp/v2/posts?per_page=1 が200を返せばOK。
 * 403の場合はXserver側IP制限 / Wordfenceブロックを疑い、停止してユーザー報告。
 */
import { CONFIG } from "../config.ts";
import type { WpPostRef, WpSnapshot, WpStatus } from "../analyze/types.ts";

function authHeader(): string {
  // 前後空白・改行を除去（環境変数/Secretsへの貼り付けで末尾改行が混入しがちなため）。
  const user = CONFIG.wp.username.trim();
  const pass = CONFIG.wp.appPassword.trim();
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

/** step3: 疎通確認。ステータスコードとサンプル記事を返す。 */
export async function pingWp(): Promise<{ ok: boolean; status: number; sample?: unknown }> {
  const url = `${CONFIG.wp.baseUrl}/wp-json/wp/v2/posts?per_page=1`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  let sample: unknown;
  try {
    sample = await res.json();
  } catch {
    sample = await res.text();
  }
  return { ok: res.ok, status: res.status, sample };
}

/**
 * 指定ステータスの記事一覧を取得（ページング対応）。
 * draft/trash は要認証。publish は認証なしでも取得可だが認証付きで統一する。
 * TODO(step4): _fields=id,link,title,slug でページング取得を実装。
 */
export async function fetchPostsByStatus(_status: WpStatus): Promise<WpPostRef[]> {
  throw new Error("not implemented (step4)");
}

/**
 * 重複・却下判定に必要な publish/draft/trash をまとめて取得する。
 * TODO(step4): fetchPostsByStatus を3ステータス分呼んで束ねる。
 */
export async function fetchWpSnapshot(): Promise<WpSnapshot> {
  throw new Error("not implemented (step4)");
}

/** リライト対象の本文をedit contextで取得。 */
export async function fetchPostContent(_id: number): Promise<{ title: string; contentHtml: string }> {
  throw new Error("not implemented (step4)");
}

export interface DraftInput {
  title: string;
  contentHtml: string;
}

/** 下書き（status=draft）として投稿し、作成された記事IDを返す。 */
export async function createDraft(_input: DraftInput): Promise<number> {
  throw new Error("not implemented (step7)");
}
