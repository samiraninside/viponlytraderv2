// Generates VAPID keys for web push. Run: npm run vapid
const { webcrypto: c } = await import("node:crypto");
const kp = await c.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await c.subtle.exportKey("raw", kp.publicKey));
const jwk = await c.subtle.exportKey("jwk", kp.privateKey);
const b64u = (b) => Buffer.from(b).toString("base64url");
console.log("VAPID_PUBLIC_KEY  =", b64u(raw));
console.log("VAPID_PRIVATE_JWK =", JSON.stringify(jwk));
console.log("\nSet both as secrets:\n  npx wrangler secret put VAPID_PUBLIC_KEY\n  npx wrangler secret put VAPID_PRIVATE_JWK");
