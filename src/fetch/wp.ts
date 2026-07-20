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
 * draft/trash は要認証。publish も認証付きで統一する。
 */
export async function fetchPostsByStatus(status: WpStatus): Promise<WpPostRef[]> {
  const perPage = 100;
  const out: WpPostRef[] = [];
  for (let page = 1; page <= 50; page++) {
    const url = `${CONFIG.wp.baseUrl}/wp-json/wp/v2/posts?status=${status}&per_page=${perPage}&page=${page}&_fields=id,link,title,slug,status`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (res.status === 400) break; // ページ範囲外（rest_post_invalid_page_number）
    if (!res.ok) throw new Error(`WP posts取得失敗 status=${status} page=${page}: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ id: number; link: string; title?: { rendered?: string }; slug?: string; status?: string }>;
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({ id: r.id, link: r.link ?? "", title: r.title?.rendered ?? "", slug: r.slug ?? "", status });
    }
    const total = Number(res.headers.get("x-wp-totalpages") ?? "1");
    if (page >= total) break;
  }
  return out;
}

/**
 * 重複・却下判定に必要な publish/draft/trash をまとめて取得する。
 */
export async function fetchWpSnapshot(): Promise<WpSnapshot> {
  const [publish, draft, trash] = await Promise.all([
    fetchPostsByStatus("publish"),
    fetchPostsByStatus("draft"),
    fetchPostsByStatus("trash"),
  ]);
  return { publish, draft, trash };
}

/** URL→記事IDマッピング用（公開記事一覧）。 */
export async function fetchPublishedPosts(): Promise<WpPostRef[]> {
  return fetchPostsByStatus("publish");
}

/** リライト対象の本文をedit contextで取得。 */
export async function fetchPostContent(id: number): Promise<{ title: string; contentHtml: string }> {
  const url = `${CONFIG.wp.baseUrl}/wp-json/wp/v2/posts/${id}?context=edit&_fields=title,content`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`WP本文取得失敗 id=${id}: HTTP ${res.status}`);
  const b = (await res.json()) as { title?: { raw?: string; rendered?: string }; content?: { raw?: string; rendered?: string } };
  return { title: b.title?.raw ?? b.title?.rendered ?? "", contentHtml: b.content?.raw ?? b.content?.rendered ?? "" };
}

export interface DraftInput {
  title: string;
  contentHtml: string;
}

/** 下書き（status=draft）として投稿し、作成された記事IDを返す。 */
export async function createDraft(_input: DraftInput): Promise<number> {
  throw new Error("not implemented (step7)");
}
