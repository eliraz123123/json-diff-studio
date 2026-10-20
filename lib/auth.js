import { randomToken, sha256 } from "./crypto.js";

// Passwordless sign-in: a one-time link by email. No passwords to store, reset or leak.
const LOGIN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SESSION_COOKIE = "jds_session";

export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function createLoginToken(db, email, now) {
  db.prepare("DELETE FROM login_tokens WHERE expires_at < ?").run(now);
  const token = randomToken();
  db.prepare("INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)")
    .run(sha256(token), email, now + LOGIN_TTL_MS);
  return token;
}

export function redeemLoginToken(db, token, now) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = db.prepare("DELETE FROM login_tokens WHERE token_hash = ? RETURNING email, expires_at").get(sha256(token));
  if (!row || row.expires_at < now) return null;
  db.prepare("INSERT INTO users (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING").run(row.email, now);
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(row.email);
  const session = randomToken();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256(session), user.id, now + SESSION_TTL_MS);
  return { user, session };
}

export function readCookie(header, name) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function sessionUser(db, cookieHeader, now) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  return db.prepare(`
    SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(sha256(token), now) ?? null;
}

export function destroySession(db, cookieHeader) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

export function sessionCookie(token, secure) {
  const maxAge = token ? SESSION_TTL_MS / 1000 : 0;
  return `${SESSION_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
