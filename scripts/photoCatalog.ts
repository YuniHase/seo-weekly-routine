/**
 * 写真カタログの構築・確認用（生成は行わない）。
 *   npx tsx scripts/photoCatalog.ts        # 未処理分をカタログ化して一覧表示
 */
import "dotenv/config";
import { fetchMediaLibrary } from "../src/fetch/media.ts";
import { buildPhotoCatalog, insertablePhotos } from "../src/generate/photoCatalog.ts";

const media = await fetchMediaLibrary();
const catalog = await buildPhotoCatalog(media);
const usable = insertablePhotos(catalog);

const byKind = new Map<string, number>();
for (const e of catalog) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
console.log("\n=== 種別 ===");
for (const [k, v] of byKind) console.log(`  ${k}: ${v}件`);

console.log(`\n=== 本文に挿入できる実物写真: ${usable.length}件 ===`);
for (const e of usable) {
  console.log(`\n  [${e.id}] ${e.description}`);
  console.log(`       話題: ${e.topics.join("・") || "-"}`);
  console.log(`       alt : ${e.alt}`);
  if (e.note) console.log(`       注記: ${e.note}`);
}
