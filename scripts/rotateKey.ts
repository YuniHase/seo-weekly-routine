/**
 * .env に入れ直した認証情報を検証し、GitHub Actions の Secret に反映する。
 *
 * このルーチンは認証情報を2箇所に持っている。
 *   .env                     … ローカル実行用
 *   GitHub Actions の Secret … 週次実行用（毎週月曜 07:00 JST）
 * 片方だけ直すと、手元では動くのに週次実行だけ静かに落ちる。
 *
 * 値はファイルから読んで gh の標準入力に直接渡す。
 * コマンド引数に置かないのは、引数がプロセス一覧やシェル履歴に残るため。
 *
 *   npx tsx scripts/rotateKey.ts ANTHROPIC_API_KEY        # 検証してSecretに反映
 *   npx tsx scripts/rotateKey.ts ANTHROPIC_API_KEY --check # 検証だけ（反映しない）
 *   npx tsx scripts/rotateKey.ts --all --check             # 全部まとめて生死確認
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const ALL = args.includes("--all");
const names = args.filter((a) => !a.startsWith("--"));

/** .env を直接読む（process.env は他の経路の値が混ざりうるため） */
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 認証情報が本当に通るかを、そのサービスの一番軽い読み取りで確かめる */
const validators: Record<string, (env: Record<string, string>) => Promise<string>> = {
  ANTHROPIC_API_KEY: async (env) => {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return "Anthropic API に接続できました";
  },
  WP_APP_PASSWORD: async (env) => {
    const r = await fetch(env.WP_BASE_URL.replace(/\/+$/, "") + "/wp-json/wp/v2/users/me", {
      headers: { Authorization: "Basic " + Buffer.from(`${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`).toString("base64") },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return "WordPress REST API に接続できました";
  },
  GOOGLE_SERVICE_ACCOUNT_JSON: async (env) => {
    const c = JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8"));
    const { google } = await import("googleapis");
    const auth = new google.auth.JWT({
      email: c.client_email,
      key: c.private_key,
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    await auth.authorize();
    return `${c.client_email} でトークンを取得できました`;
  },
};

const env = readEnvFile();
const targets = ALL ? Object.keys(validators) : names;
if (!targets.length) throw new Error("対象を指定してください（例: rotateKey.ts ANTHROPIC_API_KEY）");

let failed = false;
for (const name of targets) {
  if (!env[name]) {
    console.log(`${name}: ⛔ .env に見つかりません`);
    failed = true;
    continue;
  }
  // 1. まず新しい値が本当に通るか確かめる。通らない値をSecretに入れると週次実行が落ちる
  try {
    const msg = validators[name] ? await validators[name](env) : "検証方法が未定義のため値の形だけ確認";
    console.log(`${name}: ✅ ${msg}`);
  } catch (e) {
    console.log(`${name}: ⛔ 検証に失敗 ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
    continue;
  }
  if (CHECK_ONLY) continue;

  // 2. 通ったものだけ Secret に反映する。値は stdin 経由（引数に置かない）
  const r = spawnSync("gh", ["secret", "set", name], { input: env[name], encoding: "utf8" });
  if (r.status !== 0) {
    console.log(`  ⛔ Secretの更新に失敗: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
    failed = true;
    continue;
  }
  console.log(`  → GitHub Actions の Secret も更新しました`);
}

if (!CHECK_ONLY && !failed) {
  const r = spawnSync("gh", ["secret", "list"], { encoding: "utf8" });
  if (r.status === 0) {
    console.log("\n現在のSecret（更新日時）:");
    console.log(r.stdout.trim().split("\n").map((l) => "  " + l).join("\n"));
  }
}
process.exit(failed ? 1 : 0);
