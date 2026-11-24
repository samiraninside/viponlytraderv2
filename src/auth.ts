/**
 * Who may open the app: Cloudflare Access (recommended: set ACCESS_TEAM_DOMAIN and ACCESS_AUD)
 * or, without Access, a single password (APP_PASSWORD) with a signed cookie.
 */
import type { Env } from "./env";

const b64uDec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
let certs: { at: number; keys: any[] } | null = null;

async function verifyAccess(env: Env, token: string): Promise<boolean> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  const head = JSON.parse(new TextDecoder().decode(b64uDec(h)));
  const body = JSON.parse(new TextDecoder().decode(b64uDec(p)));
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!aud.includes(env.ACCESS_AUD) || body.exp * 1000 < Date.now()) return false;
  if (!certs || Date.now() - certs.at > 3600e3) {
    const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    certs = { at: Date.now(), keys: ((await r.json()) as any).keys ?? [] };
  }
  const jwk = certs.keys.find((k) => k.kid === head.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDec(s), new TextEncoder().encode(`${h}.${p}`));
}

async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)))));
}

const cookie = (req: Request, name: string) =>
  (req.headers.get("Cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(name + "="))?.slice(name.length + 1);

export async function authorised(req: Request, env: Env): Promise<boolean> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const tok = req.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(req, "CF_Authorization");
    return !!tok && (await verifyAccess(env, tok).catch(() => false));
  }
  if (env.APP_PASSWORD) {
    const v = cookie(req, "vt");
    if (!v) return false;
    const [exp, sig] = decodeURIComponent(v).split(".");
    return +exp > Date.now() && sig === (await hmac(env.APP_PASSWORD, `session:${exp}`));
  }
  return false; // nothing configured: locked
}

export async function login(req: Request, env: Env): Promise<Response> {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!env.APP_PASSWORD || password !== env.APP_PASSWORD) return new Response("no", { status: 401 });
  const exp = Date.now() + 30 * 86400e3;
  const v = encodeURIComponent(`${exp}.${await hmac(env.APP_PASSWORD, `session:${exp}`)}`);
  return new Response("ok", { headers: { "Set-Cookie": `vt=${v}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Strict` } });
}
