/**
 * Google API 認証（サービスアカウントJWT）。
 * GOOGLE_SERVICE_ACCOUNT_JSON は「JSONキーの中身をbase64エンコードした1行文字列」。
 * デコード→JSON.parse し、GSC(webmasters.readonly) と GA4(analytics.readonly) の
 * 読み取りスコープで GoogleAuth を生成する。
 */
import { google } from "googleapis";
import { CONFIG } from "../config.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

let _auth: InstanceType<typeof google.auth.JWT> | null = null;

export function getGoogleAuth() {
  if (_auth) return _auth;
  const b64 = CONFIG.google.serviceAccountB64.trim();
  if (!b64) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON が未設定です（base64エンコードしたサービスアカウントJSONを設定してください）");
  }
  let credentials: { client_email?: string; private_key?: string };
  try {
    credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON のデコード/パースに失敗しました。base64化した有効なJSONか確認してください: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("サービスアカウントJSONに client_email / private_key が見当たりません");
  }
  // JWTクライアント（OAuth2Client互換）。GoogleAuth<JSONClient>のジェネリック不整合を回避。
  _auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });
  return _auth;
}

/** 認証情報の client_email（権限付与の確認用。秘密ではない） */
export function serviceAccountEmail(): string {
  const b64 = CONFIG.google.serviceAccountB64.trim();
  const c = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  return String(c.client_email ?? "");
}
