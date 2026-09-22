/**
 * アフィリエイトショートコードが指す「商品名」を実ページから解決する。
 *
 * 記事本文(raw)には [affi id=9] としか書かれておらず、それがどの商品かは分からない。
 * 使用文脈からモデルに推測させると取り違える（実例: SIXPADのコードをBAKUNEの
 * シリーズとして挿入した）。かといって使用回数の少ないコードを除外すると、
 * その商品には二度とリンクを張れなくなる。
 *
 * 公開ページのレンダリング結果にはショートコードが展開され、
 *   <a ... data-atag-id="9" href="https://amzn.to/xxxx"><img alt="SIXPAD リカバリーウェア クルーネック">
 * のように **id と商品名が一緒に出力されている**。ここから正確に解決する。
 *
 * 解決結果は data/shortcodeProducts.json にキャッシュし、未解決のコードがあるときだけ
 * ページを取りに行く。商品名が変われば再取得すれば追従する。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../util/logger.ts";
import type { AffiliateShortcode } from "./wp.ts";

export interface ShortcodeProduct {
  /** [affi id=9] の 9 */
  id: string;
  /** 商品名（レンダリング結果から取得） */
  product: string;
  /** リンク先（amzn.to / 楽天など）。商品の同定確認用 */
  href?: string;
}

const FILE = "data/shortcodeProducts.json";

function load(): ShortcodeProduct[] {
  if (!existsSync(FILE)) return [];
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as ShortcodeProduct[];
  } catch {
    return [];
  }
}

function save(list: ShortcodeProduct[]): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify([...list].sort((a, b) => Number(a.id) - Number(b.id)), null, 2) + "\n");
}

/** 商品名ではない汎用的なalt（サイト名・プロフィール等）を除く */
const GENERIC_ALT = /Recovery Lab|プロフィール|アイキャッチ|ロゴ|logo|avatar/i;

/**
 * レンダリング済みHTMLから data-atag-id と商品名の組を抜き出す。
 *
 * 商品名の位置はブロックの作りによって2通りある。
 *  (a) アンカーの内側に商品画像がある（img alt が後ろに来る）
 *  (b) アンカーがテキストボタン（「メンズ」等）で、商品画像・商品名は前にある
 * 前方・後方の両方を見て、近いほうを採用する。
 */
export function harvestFromHtml(html: string): ShortcodeProduct[] {
  const out = new Map<string, ShortcodeProduct>();
  const anchorRe = /data-atag-id=["'](\d+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const id = m[1];
    if (out.has(id)) continue;
    const at = m.index;

    // (a) 後方（アンカー内の商品画像）
    const after = html.slice(at, at + 600);
    const fwd = [...after.matchAll(/alt=["']([^"']{2,120})["']/g)]
      .map((x) => x[1].trim())
      .find((a) => !GENERIC_ALT.test(a));

    // (b) 前方（テキストボタン型。直前の商品画像・商品名を拾う）
    const before = html.slice(Math.max(0, at - 3000), at);
    const back = [...before.matchAll(/alt=["']([^"']{2,120})["']/g)]
      .map((x) => x[1].trim())
      .filter((a) => !GENERIC_ALT.test(a))
      .pop();

    const product = fwd ?? back;
    if (product) out.set(id, { id, product });
  }
  // リンク先も拾えれば添える（商品の同定確認用）
  const hrefRe = /data-atag-id=["'](\d+)["'][^>]*href=["']([^"']+)["']/g;
  while ((m = hrefRe.exec(html))) {
    const e = out.get(m[1]);
    if (e && !e.href) e.href = m[2];
  }
  return [...out.values()];
}

/** [affi id=9] → "9" */
function idOf(code: string): string | null {
  return /id\s*=\s*(\d+)/.exec(code)?.[1] ?? null;
}

/**
 * カタログ中の未解決コードについて、それを使っている記事の公開ページを取得して商品名を解決する。
 * 1ページに複数のコードが載っていることが多いので、取得したページからは全件を回収する。
 */
export async function resolveShortcodeProducts(
  catalog: AffiliateShortcode[],
  siteBaseUrl: string,
): Promise<Map<string, ShortcodeProduct>> {
  const known = new Map(load().map((p) => [p.id, p]));
  const unresolved = catalog
    .map((c) => ({ code: c.code, id: idOf(c.code), slug: c.articles[0] }))
    .filter((c): c is { code: string; id: string; slug: string } => !!c.id && !!c.slug && !known.has(c.id));

  if (unresolved.length === 0) {
    log.info("ショートコードの商品名はキャッシュ済み", { resolved: known.size });
    return known;
  }

  const base = siteBaseUrl.replace(/\/+$/, "");
  const visited = new Set<string>();
  for (const u of unresolved) {
    if (known.has(u.id)) continue; // 直前のページ取得で解決済み
    if (visited.has(u.slug)) continue;
    visited.add(u.slug);
    try {
      const res = await fetch(`${base}/${u.slug}/`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; seo-routine)" } });
      if (!res.ok) { log.warn("ページ取得に失敗", { slug: u.slug, status: res.status }); continue; }
      const html = await res.text();
      for (const p of harvestFromHtml(html)) if (!known.has(p.id)) known.set(p.id, p);
    } catch (e) {
      log.warn("ページ取得に失敗", { slug: u.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }

  save([...known.values()]);
  const still = catalog.map((c) => idOf(c.code)).filter((id): id is string => !!id && !known.has(id));
  log.info("ショートコードの商品名を解決", { resolved: known.size, 未解決: still.length, ids: still.join(",") || "なし" });
  return known;
}

/** カタログに商品名を付与する（解決できなかったものは product 未設定のまま） */
export function attachProducts(
  catalog: AffiliateShortcode[],
  products: Map<string, ShortcodeProduct>,
): Array<AffiliateShortcode & { product?: string }> {
  return catalog.map((c) => {
    const id = idOf(c.code);
    const p = id ? products.get(id) : undefined;
    return p ? { ...c, product: p.product } : { ...c };
  });
}
