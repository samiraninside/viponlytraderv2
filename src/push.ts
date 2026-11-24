/**
 * Web Push without a payload (no encryption needed): the tablet's service worker wakes up,
 * fetches /api/push-latest and shows the notification. Signed with VAPID (ES256).
 */
import { type IST, toMins } from "./calendar";
import { SCHEDULE, SCORE } from "./config";
import { getKv, putKv } from "./universe";
import type { Card } from "./engine/opportunities";
import type { Env } from "./env";

const b64u = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function vapidJwt(env: Env, endpoint: string) {
  const aud = new URL(endpoint).origin;
  const enc = (o: object) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const body = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com" });
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

export async function pushOne(env: Env, endpoint: string): Promise<number> {
  const jwt = await vapidJwt(env, endpoint);
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`, TTL: "300", Urgency: "high", "Content-Length": "0" },
  });
  return r.status;
}

function quiet(t: IST) {
  const [a, b] = SCHEDULE.quietHours.map(toMins);
  return a > b ? t.mins >= a || t.mins < b : t.mins >= a && t.mins < b;
}

/** Push for cards that just became ENTER with a high score, per subscriber's profile. */
export async function sendPushes(env: Env, t: IST) {
  if (!env.VAPID_PRIVATE_JWK || quiet(t)) return;
  const { results } = await env.DB.prepare("SELECT id, json FROM cards WHERE date=? AND status='ENTER' AND score>=?").bind(t.date, SCORE.pushAt).all<{ id: string; json: string }>();
  const all = results.map((r) => JSON.parse(r.json) as Card);
  const sent: Record<string, number> = {};
  for (const c of all) if (c.pushed) sent[c.profile] = (sent[c.profile] ?? 0) + 1;
  // daily cap per profile (from the old engine's "10 signals a day"): best-ranked first
  const fresh = all.filter((c) => !c.pushed && c.ev > 0 && !c.overCap && !c.chase && !c.blocked)
    .sort((a, b) => (b.rank ?? b.score) - (a.rank ?? a.score))
    .filter((c) => (sent[c.profile] = (sent[c.profile] ?? 0) + 1) <= SCORE.maxPushPerDay);
  if (!fresh.length) return;
  const subs = (await env.DB.prepare("SELECT endpoint, profile FROM subs").all<{ endpoint: string; profile: string }>()).results;
  const profiles = new Set(fresh.map((c) => c.profile));
  for (const s of subs) {
    if (!profiles.has(s.profile as Card["profile"])) continue;
    const code = await pushOne(env, s.endpoint).catch(() => 0);
    if (code === 404 || code === 410) await env.DB.prepare("DELETE FROM subs WHERE endpoint=?").bind(s.endpoint).run();
  }
  const st = env.DB.prepare("UPDATE cards SET json=? WHERE id=?");
  await env.DB.batch(fresh.map((c) => st.bind(JSON.stringify({ ...c, pushed: true, pushedAt: Date.now() }), c.id)));
}

export interface Alert { title: string; body: string; tag: string; at?: number }

/** Alerts that must reach you whatever the daily cap (exits on your own trades). Quiet hours still apply. */
export async function pushAll(env: Env, t: IST, msgs: Alert[]) {
  const q = (await getKv<Alert[]>(env, "alerts")) ?? [];
  q.push(...msgs.map((m) => ({ ...m, at: Date.now() })));
  await putKv(env, "alerts", q.slice(-20));
  if (!env.VAPID_PRIVATE_JWK || quiet(t)) return;
  const subs = (await env.DB.prepare("SELECT endpoint FROM subs").all<{ endpoint: string }>()).results;
  for (const s of subs) {
    const code = await pushOne(env, s.endpoint).catch(() => 0);
    if (code === 404 || code === 410) await env.DB.prepare("DELETE FROM subs WHERE endpoint=?").bind(s.endpoint).run();
  }
}
