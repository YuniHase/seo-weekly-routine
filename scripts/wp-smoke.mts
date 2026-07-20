/**
 * 一時: GitHub Actions の海外IPから WP REST API に読み書きできるかを本番同等で確認する
 * スモークテスト。step3（ローカル・国内IP）と同じ6操作を GHA ランナー上で実行する。
 *
 * 検証完了後、このスクリプトと .github/workflows/wp-smoke.yml は削除する。
 * 認証情報は GitHub Secrets → workflow env 経由で渡す（WP_BASE_URL / WP_USERNAME / WP_APP_PASSWORD）。
 * ローカルでも `.env` があれば dotenv 経由で動く。
 */
import "dotenv/config";
import { createHash } from "node:crypto";

// 前後空白・改行を除去（GitHub Secretsへの貼り付けで末尾改行が混入しがちなため防御）。
// アプリパスワード内部のスペースは trim では消えないので安全。
const BASE = (process.env.WP_BASE_URL ?? "").trim().replace(/\/+$/, "");
const USER = (process.env.WP_USERNAME ?? "").trim();
const PASS = (process.env.WP_APP_PASSWORD ?? "").trim();
const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

/** 値を晒さずに指紋を出す（ローカル.envとGHA Secretの一致確認用）。 */
function fingerprint(name: string, raw: string) {
  const t = raw.trim();
  const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
  console.log(
    `  ${name.padEnd(16)} len=${raw.length} trimLen=${t.length} trailingWS=${raw.length !== t.length}` +
      ` first=${raw.charCodeAt(0) || "-"} last=${raw.charCodeAt(raw.length - 1) || "-"}` +
      ` sha(raw)=${raw ? h(raw) : "-"} sha(trim)=${t ? h(t) : "-"}`,
  );
}

if (!BASE || !USER || !PASS) {
  console.error("必須の環境変数が不足しています（WP_BASE_URL / WP_USERNAME / WP_APP_PASSWORD）。GitHub Secrets を確認してください。");
  process.exit(1);
}

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}  — ${detail}`);
  if (!ok) failures++;
}

async function req(path: string, withAuth: boolean, init: RequestInit = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
  if (withAuth) headers["Authorization"] = auth;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { res, body };
}

async function main() {
  console.log(`WP GHAスモークテスト（海外IP経路）: ${BASE}`);
  console.log(`ランナーの外向きIP: ${await fetch("https://api.ipify.org").then((r) => r.text()).catch(() => "取得失敗")}`);
  console.log("認証情報の指紋（ローカル.envの基準値と突き合わせる。sha が一致すれば値は同一）:");
  fingerprint("WP_BASE_URL", process.env.WP_BASE_URL ?? "");
  fingerprint("WP_USERNAME", process.env.WP_USERNAME ?? "");
  fingerprint("WP_APP_PASSWORD", process.env.WP_APP_PASSWORD ?? "");

  // 1. 認証なし・公開記事一覧
  {
    const { res, body } = await req("/wp-json/wp/v2/posts?per_page=1&_fields=id,link,title,slug", false);
    check("1. GET publish (no auth)", res.status === 200 && Array.isArray(body), `status=${res.status} len=${Array.isArray(body) ? body.length : "n/a"}`);
  }
  // 2. 認証あり・公開記事一覧
  {
    const { res, body } = await req("/wp-json/wp/v2/posts?per_page=3&status=publish&_fields=id,link,title,slug", true);
    check("2. GET publish (auth)", res.status === 200 && Array.isArray(body), `status=${res.status} len=${Array.isArray(body) ? body.length : "n/a"}`);
  }
  // 3. 認証なし・draft → 保護されているべき（400 or 401）
  {
    const { res } = await req("/wp-json/wp/v2/posts?per_page=1&status=draft&_fields=id,link,title,slug", false);
    check("3. GET draft (NO auth) 保護確認", res.status === 400 || res.status === 401, `status=${res.status}（非公開は弾かれるのが正）`);
  }
  // 4. 認証あり・draft
  {
    const { res, body } = await req("/wp-json/wp/v2/posts?per_page=5&status=draft&_fields=id,link,title,slug", true);
    check("4. GET draft (auth)", res.status === 200 && Array.isArray(body), `status=${res.status} len=${Array.isArray(body) ? body.length : "n/a"}`);
  }
  // 5. 認証あり・trash
  {
    const { res, body } = await req("/wp-json/wp/v2/posts?per_page=5&status=trash&_fields=id,link,title,slug", true);
    check("5. GET trash (auth)", res.status === 200 && Array.isArray(body), `status=${res.status} len=${Array.isArray(body) ? body.length : "n/a"}`);
  }
  // 6. 認証あり・テスト下書きPOST → 確認後ゴミ箱へ移動して自己クリーンアップ
  {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const title = `【AI提案/テスト】GHAスモーク ${now} UTC`;
    const content = `<!-- GHA smoke test | ${now} UTC | 削除してOK -->\n<p>GitHub Actions からの疎通確認用テスト下書き。自動でゴミ箱へ移動されます。</p>`;
    const { res, body } = await req("/wp-json/wp/v2/posts", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, status: "draft" }),
    });
    const id = (body as { id?: number }).id;
    const created = res.status === 201 && !!id;
    check("6a. POST draft (auth)", created, `status=${res.status} id=${id ?? "n/a"}`);
    if (created) {
      const del = await req(`/wp-json/wp/v2/posts/${id}`, true, { method: "DELETE" });
      const trashed = del.res.status === 200 && (del.body as { status?: string }).status === "trash";
      check("6b. DELETE→trash (cleanup)", trashed, `status=${del.res.status} -> ${(del.body as { status?: string }).status ?? "?"}`);
    }
  }

  console.log(`\n=== 結果: ${failures === 0 ? "全PASS ✅（海外IPから読み書き可能）" : `${failures}件FAIL ❌`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("実行エラー:", e instanceof Error ? e.message : String(e)); process.exit(1); });
