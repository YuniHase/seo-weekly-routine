/**
 * 環境変数の読み込みと検証。
 * 起動時に一度だけ読み、型付きの CONFIG として全モジュールで共有する。
 */
import "dotenv/config";

function str(name: string, required = true, fallback = ""): string {
  const v = process.env[name] ?? "";
  if (!v && required) {
    throw new Error(`環境変数 ${name} が未設定です（.env.example を参照）`);
  }
  return v || fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} は整数である必要があります: "${v}"`);
  return n;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

/**
 * base64エンコードされたサービスアカウントJSONをデコードしてパースする。
 * 検証は実際にGoogleクライアントを組む fetch/ 側で行うため、ここでは生文字列のみ保持。
 */
export const CONFIG = {
  google: {
    serviceAccountB64: str("GOOGLE_SERVICE_ACCOUNT_JSON", false),
    ga4PropertyId: str("GA4_PROPERTY_ID", false),
    gscSiteUrl: str("GSC_SITE_URL", false, "https://recovery-wear-guide.com/"),
  },
  wp: {
    baseUrl: str("WP_BASE_URL", false, "https://recovery-wear-guide.com").replace(/\/+$/, ""),
    username: str("WP_USERNAME", false),
    appPassword: str("WP_APP_PASSWORD", false),
  },
  anthropic: {
    apiKey: str("ANTHROPIC_API_KEY", false),
    model: str("ANTHROPIC_MODEL", false, "claude-sonnet-5"),
  },
  run: {
    maxDraftsPerRun: int("MAX_DRAFTS_PER_RUN", 3),
    lookbackDays: int("LOOKBACK_DAYS", 28),
    dataDelayDays: int("DATA_DELAY_DAYS", 3),
    dryRun: bool("DRY_RUN", true),
    // 収益重み: アフィクリックの伸びしろをスコアにどれだけ反映するか（0=無効, 1=最大2倍）
    revenueWeight: num("REVENUE_WEIGHT", 1),
    // アフィリンク1クリックあたりの期待報酬(円)。週次レポートの収益上限の概算にのみ使う。
    // 実報酬はASP管理画面でしか分からないため、確定値ではなく目安。ASPの実績に合わせて調整する。
    affiliateEpcYen: num("AFFILIATE_EPC_YEN", 30),
    // 本文への自動挿入を許可する写真の、アップロード日の下限（YYYY-MM-DD）。
    // 自分で撮った写真かどうかは画像からは判別できないため、日付で明示的に線を引く。
    // 未設定なら自動挿入しない（既存のメディアには公式商品画像等が混在しうるため安全側に倒す）。
    ownPhotoSince: str("OWN_PHOTO_SINCE", false),
  },
  batch: {
    // 本番は Batch API（50%オフ・非同期）。USE_BATCH=false で同期に切替（デバッグ用）。
    useBatch: bool("USE_BATCH", true),
    pollIntervalMs: int("BATCH_POLL_INTERVAL_MS", 15000),
    maxWaitMs: int("BATCH_MAX_WAIT_MS", 1800000), // 30分でタイムアウト
  },
};

export type Config = typeof CONFIG;
