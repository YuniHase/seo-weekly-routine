/**
 * ローカルの写真をWordPressメディアライブラリへアップロードする。
 *
 * 本文への自動挿入は「OWN_PHOTO_SINCE 以降にアップロードされた画像」に限られる。
 * 自分で撮った写真かは画像から判別できないため日付で線を引いており、
 * この経路で上げた写真はその日付以降になるので対象になる。
 *
 *   npx tsx scripts/uploadPhotos.ts <ディレクトリ>
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { CONFIG } from "../src/config.ts";
import { log } from "../src/util/logger.ts";

const dir = process.argv[2];
if (!dir) throw new Error("写真のあるディレクトリを指定してください");

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const files = readdirSync(dir).filter((f) => MIME[extname(f).toLowerCase()]);
if (files.length === 0) throw new Error("画像が見つかりません");

const auth = "Basic " + Buffer.from(`${CONFIG.wp.username.trim()}:${CONFIG.wp.appPassword.trim()}`).toString("base64");
log.info("アップロードを開始します", { dir, count: files.length });

for (const f of files) {
  const buf = readFileSync(join(dir, f));
  const res = await fetch(`${CONFIG.wp.baseUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": MIME[extname(f).toLowerCase()],
      "Content-Disposition": `attachment; filename="${basename(f)}"`,
    },
    body: new Uint8Array(buf),
  });
  if (!res.ok) {
    console.log(`  ✕ ${f}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    continue;
  }
  const j = (await res.json()) as { id: number; source_url: string };
  console.log(`  ✅ ${f} → id=${j.id}`);
}
