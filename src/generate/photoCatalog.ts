/**
 * 写真カタログ（画像認識で「何が写っているか」を自動で作る）。
 *
 * アフィリエイトのショートコードでうまくいった方式と同じ考え方:
 *   サイトから実在するものを収集 → 使いどころつきでプロンプトに渡す
 *   → モデルに文脈で選ばせる → 実在しないものを使っていたら事後除去。
 *
 * 人間はメディアライブラリに撮った写真を上げるだけでよく、
 * ファイル名やaltの整備は不要（中身を見て判別するため）。
 *
 * 権利面の都合で、自動挿入の対象は kind="photo"（自分で撮った実物写真）に限る。
 * 他サイトの画面キャプチャや商品ページのスクリーンショットは規約違反になりうるため
 * 挿入候補から外す。判定はモデルが行うので確実ではなく、最終確認は人間が行う前提。
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config.ts";
import { log } from "../util/logger.ts";
import { fetchImageBase64, type MediaItem } from "../fetch/media.ts";

export interface PhotoEntry {
  id: number;
  url: string;
  /** 実物写真か、画面キャプチャか、図版か */
  kind: "photo" | "screenshot" | "graphic" | "unknown";
  /** 何が写っているか（挿入箇所の判断材料） */
  description: string;
  /** どの話題の記事で使えるか */
  topics: string[];
  /** alt属性の案 */
  alt: string;
  /** 判定が不確かな場合の注記 */
  note?: string;
  /** アップロード日時（自分で撮った写真かの判定に使う） */
  date?: string;
}

const CATALOG_FILE = "data/photoCatalog.json";

export function loadPhotoCatalog(): PhotoEntry[] {
  if (!existsSync(CATALOG_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as PhotoEntry[];
  } catch {
    return [];
  }
}

function savePhotoCatalog(entries: PhotoEntry[]): void {
  mkdirSync(dirname(CATALOG_FILE), { recursive: true });
  writeFileSync(CATALOG_FILE, JSON.stringify([...entries].sort((a, b) => a.id - b.id), null, 2) + "\n");
}

const VISION_PROMPT = `この画像はリカバリーウェア（睡眠時に着る機能性ウェア）のレビューサイトで使う素材です。
記事本文のどこに挿入できるか判断するための情報を作ってください。

次のJSONのみを返してください（前後に説明文やコードフェンスを付けない）:
{
  "kind": "photo" | "screenshot" | "graphic" | "unknown",
  "description": "何が写っているかの客観的な説明（40〜80字）",
  "topics": ["この画像が使える記事の話題", "..."],
  "alt": "alt属性に使う簡潔な説明（30字程度）",
  "note": "判断に迷う点があれば書く。無ければ空文字"
}

kind の判定基準:
- photo: 実物を撮影した写真（衣類、タグ、質感、着用シーンなど）
- screenshot: PC・スマホの画面キャプチャ（他サイトや商品ページの画面を含む）
- graphic: 図表・イラスト・文字主体のバナー
- unknown: 判断できない

topics は次のような粒度で: "洗濯・お手入れ", "寿命・買い替え", "サイズ選び", "裏起毛・冬用",
"夏用・通気性", "着用シーン", "BAKUNE", "VENEX", "生地の質感", "洗濯表示タグ"

注意:
- 画像に写っていないことを推測で書かない。
- 効果・効能を示唆する表現（「疲れが取れた」等）は書かない。客観的な描写に留める。`;

/** JSONを頑健に取り出す */
function parseJson(text: string): Record<string, unknown> | null {
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * 未カタログの画像だけを画像認識にかけてカタログを更新する。
 * 既存分はキャッシュを使うので、実行のたびに課金されるのは新規アップロード分だけ。
 */
export async function buildPhotoCatalog(media: MediaItem[], limit = 40): Promise<PhotoEntry[]> {
  const existing = loadPhotoCatalog();
  const known = new Map(existing.map((e) => [e.id, e]));
  const targets = media.filter((m) => !known.has(m.id)).slice(0, limit);

  if (targets.length === 0) {
    log.info("写真カタログは最新です", { entries: existing.length });
    return existing;
  }
  if (!CONFIG.anthropic.apiKey) {
    log.warn("ANTHROPIC_API_KEY が無いため写真カタログを更新できません");
    return existing;
  }

  log.info("写真カタログを更新します（画像認識）", { new: targets.length, cached: existing.length });
  const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
  const added: PhotoEntry[] = [];

  for (const m of targets) {
    const img = await fetchImageBase64(m.thumbUrl);
    if (!img) {
      log.warn("画像を取得できずスキップ", { id: m.id, file: m.filename });
      continue;
    }
    try {
      const res = await client.messages.create({
        model: CONFIG.anthropic.model,
        max_tokens: 1000,
        thinking: { type: "disabled" as const },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType as "image/jpeg", data: img.base64 } },
              { type: "text", text: VISION_PROMPT },
            ],
          },
        ],
      });
      const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const obj = parseJson(text);
      if (!obj) {
        log.warn("画像認識の結果を解析できずスキップ", { id: m.id });
        continue;
      }
      const kind = String(obj.kind ?? "unknown");
      added.push({
        id: m.id,
        url: m.url,
        kind: (["photo", "screenshot", "graphic"].includes(kind) ? kind : "unknown") as PhotoEntry["kind"],
        description: String(obj.description ?? ""),
        topics: Array.isArray(obj.topics) ? (obj.topics as unknown[]).map(String) : [],
        alt: String(obj.alt ?? m.altText ?? ""),
        note: obj.note ? String(obj.note) : undefined,
        date: m.date,
      });
    } catch (e) {
      log.warn("画像認識に失敗", { id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const merged = [...existing, ...added];
  savePhotoCatalog(merged);
  const photos = merged.filter((e) => e.kind === "photo").length;
  log.info("写真カタログを更新しました", { total: merged.length, added: added.length, 挿入可能な実物写真: photos });
  return merged;
}

/**
 * 本文への自動挿入に使ってよい写真だけを返す。
 *
 * 「実物写真か」は画像認識で分かるが、「**自分で撮った**写真か」は画像からは分からない。
 * 白背景の商品カットは公式サイトやAmazonの画像である可能性があり、無断使用は規約違反になる。
 * そこでアップロード日で明示的に線を引く（OWN_PHOTO_SINCE 以降のもののみ許可）。
 * 未設定なら1枚も許可しない（安全側）。
 */
export function insertablePhotos(catalog: PhotoEntry[]): PhotoEntry[] {
  const since = CONFIG.run.ownPhotoSince.trim();
  if (!since) {
    const candidates = catalog.filter((e) => e.kind === "photo").length;
    if (candidates > 0) {
      log.info("OWN_PHOTO_SINCE が未設定のため写真の自動挿入は行いません", { 実物写真の候補: candidates });
    }
    return [];
  }
  return catalog.filter(
    (e) => e.kind === "photo" && e.description.length > 0 && e.date && e.date.slice(0, 10) >= since,
  );
}
