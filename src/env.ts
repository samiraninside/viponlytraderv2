export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // secrets (wrangler secret put ...)
  DHAN_CLIENT_ID: string;
  DHAN_PIN: string;
  DHAN_TOTP_SECRET: string;
  VAPID_PUBLIC_KEY: string;    // base64url, uncompressed P-256 point
  VAPID_PRIVATE_JWK: string;   // JSON JWK
  VAPID_SUBJECT?: string;      // mailto:you@example.com
  ACCESS_TEAM_DOMAIN?: string; // yourteam.cloudflareaccess.com
  ACCESS_AUD?: string;         // Access application AUD tag
  APP_PASSWORD?: string;       // fallback login if you don't use Cloudflare Access
}
