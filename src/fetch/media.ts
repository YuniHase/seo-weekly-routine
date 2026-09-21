/**
 * WordPress メディアライブラリの取得（本文への写真自動挿入用）。
 *
 * 記事本文には現在1枚も画像が無く、体験レビュー記事の説得力を落としている。
 * 人間が撮ってアップロードした実物写真を、生成時に文脈へ挿入できるようにする。
 *
 * 画像そのものの権利判定はできないため、何を挿入してよいかは photoCatalog 側の
 * 画像認識で「実物写真かスクリーンショットか」を判別して絞り込む。
 */
import { CONFIG } from "../config.ts";
import { log } from "../util/logger.ts";

export interface MediaItem {
  id: number;
  /** フルサイズのURL（本文に入れるのはこれ） */
  url: string;
  /** 画像認識に渡す小さめのURL（トークン節約） */
  thumbUrl: string;
  mimeType: string;
  altText: string;
  filename: string;
  /** アップロード日時（ISO）。自分で撮った写真かの判定に使う */
  date: string;
  width?: number;
  height?: number;
}

interface WpMediaSize {
  source_url?: string;
  width?: number;
  height?: number;
}

interface WpMedia {
  id: number;
  date_gmt?: string;
  source_url: string;
  mime_type: string;
  alt_text?: string;
  media_details?: { width?: number; height?: number; sizes?: Record<string, WpMediaSize> };
}

function authHeader(): string {
  const u = CONFIG.wp.username.trim();
  const p = CONFIG.wp.appPassword.trim();
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

/** 画像認識に渡すのに手頃なサイズを選ぶ（無ければフルサイズ） */
function pickThumb(m: WpMedia): string {
  const sizes = m.media_details?.sizes ?? {};
  for (const key of ["medium_large", "medium", "large"]) {
    const s = sizes[key];
    if (s?.source_url) return s.source_url;
  }
  return m.source_url;
}

/** 画像メディアを全件取得（ページング対応） */
export async function fetchMediaLibrary(): Promise<MediaItem[]> {
  const out: MediaItem[] = [];
  for (let page = 1; page <= 20; page++) {
    const url = `${CONFIG.wp.baseUrl}/wp-json/wp/v2/media?per_page=100&page=${page}&media_type=image&_fields=id,date_gmt,source_url,mime_type,alt_text,media_details`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (res.status === 400) break; // ページ超過
    if (!res.ok) throw new Error(`メディア取得に失敗しました: ${res.status}`);
    const rows = (await res.json()) as WpMedia[];
    if (rows.length === 0) break;
    for (const m of rows) {
      out.push({
        id: m.id,
        url: m.source_url,
        thumbUrl: pickThumb(m),
        mimeType: m.mime_type,
        altText: m.alt_text ?? "",
        filename: decodeURIComponent(m.source_url.split("/").pop() ?? ""),
        date: m.date_gmt ?? "",
        width: m.media_details?.width,
        height: m.media_details?.height,
      });
    }
    if (rows.length < 100) break;
  }
  log.info("メディア取得完了", { images: out.length });
  return out;
}

/** 画像バイト列を取得して base64 にする（画像認識APIに渡す用） */
export async function fetchImageBase64(url: string): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mediaType = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Claudeの画像サイズ上限に対する保険（概ね5MB）
    if (buf.byteLength > 4_500_000) return null;
    return { base64: buf.toString("base64"), mediaType };
  } catch {
    return null;
  }
}

/** 本文にalt付きで挿入する<img>を組み立てる（Gutenberg画像ブロック） */
export function imageBlock(item: MediaItem, alt: string, caption?: string): string {
  const cap = caption
    ? `<figcaption class="wp-element-caption">${caption}</figcaption>`
    : "";
  return (
    `<!-- wp:image {"id":${item.id},"sizeSlug":"large","linkDestination":"none"} -->\n` +
    `<figure class="wp-block-image size-large">` +
    `<img src="${item.url}" alt="${alt.replace(/"/g, "&quot;")}" class="wp-image-${item.id}"/>` +
    `${cap}</figure>\n` +
    `<!-- /wp:image -->`
  );
}
