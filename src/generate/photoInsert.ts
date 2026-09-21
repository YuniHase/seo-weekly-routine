/**
 * 生成結果の [PHOTO:id|alt] マーカーを WordPress の画像ブロックに置き換える。
 *
 * モデルに <img> やURLを直接書かせると、存在しない画像URLを創作しうる。
 * そこでマーカーだけ出させ、実在するメディアIDとの突合はコード側で行う。
 * アフィリエイトのショートコード検証と同じ考え方。
 */
import { imageBlock, type MediaItem } from "../fetch/media.ts";
import type { PhotoEntry } from "./photoCatalog.ts";

export interface PhotoInsertResult {
  html: string;
  inserted: number[];
  /** カタログに無いidが指定され、除去したもの */
  rejected: number[];
}

const MARKER = /\[PHOTO:\s*(\d+)\s*(?:\|([^\]]*))?\]/g;

/**
 * マーカーを画像ブロックに変換する。
 * 挿入を許可するのは allowed（実物写真のみ）に含まれるIDだけ。
 * 同じ画像が複数回指定された場合は2回目以降を落とす（重複挿入を防ぐ）。
 */
export function applyPhotoMarkers(
  html: string,
  allowed: PhotoEntry[],
  media: MediaItem[],
): PhotoInsertResult {
  const byId = new Map(media.map((m) => [m.id, m]));
  const allowedIds = new Set(allowed.map((p) => p.id));
  const altById = new Map(allowed.map((p) => [p.id, p.alt]));
  const inserted: number[] = [];
  const rejected: number[] = [];
  const used = new Set<number>();

  const out = html.replace(MARKER, (_m, idStr: string, altRaw?: string) => {
    const id = Number(idStr);
    const item = byId.get(id);
    if (!item || !allowedIds.has(id)) {
      rejected.push(id);
      return "";
    }
    if (used.has(id)) return ""; // 同一画像の重複挿入は落とす
    used.add(id);
    inserted.push(id);
    const alt = (altRaw ?? "").trim() || altById.get(id) || item.altText || "";
    return "\n" + imageBlock(item, alt) + "\n";
  });

  return { html: out, inserted, rejected };
}

/**
 * 念のため、モデルが直接書いた <img> のうち自サイトのメディア以外を除去する。
 * 外部サイトの画像直リンクは権利面のリスクがあるため通さない。
 */
export function stripForeignImages(html: string, siteBaseUrl: string): { html: string; removed: number } {
  let removed = 0;
  const host = (() => {
    try {
      return new URL(siteBaseUrl).host.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /src="([^"]+)"/i.exec(tag)?.[1] ?? "";
    if (host && src.includes(host)) return tag;
    removed++;
    return "";
  });
  return { html: out, removed };
}
