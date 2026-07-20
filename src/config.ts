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
  },
};

export type Config = typeof CONFIG;
