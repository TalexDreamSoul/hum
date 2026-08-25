import "server-only";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { hashPassword, verifyPassword } from "./crypto";
import { cleanExpiredSecurityRows, getDb, type HumDatabase } from "./database";
import { getDataDir, readOrCreatePrivateFile } from "./data-dir";

export type UserRole = "admin" | "approver" | "uploader";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  role: UserRole;
  status: "active" | "disabled";
}

const SESSION_COOKIE = "hum_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD = hashPassword("hum-auth-dummy-password", Buffer.alloc(16, 7));

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeEqualText(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export async function isInitialized(): Promise<boolean> {
  const row = await getDb().prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  return row.count > 0;
}

export async function ensureSetupCode(): Promise<string | null> {
  if (await isInitialized()) return null;
  const value = readOrCreatePrivateFile("setup-code.txt", () => Buffer.from(`${randomBytes(18).toString("base64url")}\n`));
  const code = value.toString("utf8").trim();
  if (!code) throw new Error("初始化码文件为空");
  return code;
}

export function getSetupCodePath(): string {
  return path.join(getDataDir(), "setup-code.txt");
}

export async function createFirstAdmin(input: {
  setupCode: string;
  username: string;
  password: string;
  displayName?: string;
}): Promise<SessionUser> {
  const username = input.username.trim();
  const displayName = input.displayName?.trim() || username;
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error("账号需为 3–64 位字母、数字、点、下划线或短横线");
  if (input.password.length < 10 || input.password.length > 128) throw new Error("密码长度需为 10–128 位");
  if (displayName.length > 80) throw new Error("显示名称不能超过 80 个字符");

  const expectedCode = await ensureSetupCode();
  if (!expectedCode || !safeEqualText(input.setupCode.trim(), expectedCode)) throw new Error("初始化码无效");

  const db = getDb();
  const now = Date.now();
  const user: SessionUser = { id: randomUUID(), username, displayName, role: "admin" };
  const password = hashPassword(input.password);
  await db.transaction(async (transaction) => {
    const count = (await transaction.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    if (count !== 0) throw new Error("系统已经完成初始化");
    await transaction.prepare(`
      INSERT INTO users (id, username, display_name, password_salt, password_hash, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?)
    `).run(user.id, user.username, user.displayName, password.salt, password.hash, now, now);
    await transaction.prepare(`
      INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json, created_at)
      VALUES (?, 'system.initialize', 'user', ?, '{}', ?)
    `).run(user.id, user.id, now);
  })();

  const codeFile = getSetupCodePath();
  if (existsSync(codeFile)) {
    try { unlinkSync(codeFile); } catch { /* setup is already atomically closed by the user row */ }
  }
  return user;
}

export async function authenticateLocal(username: string, password: string): Promise<SessionUser | null> {
  const row = await getDb().prepare(`
    SELECT id, username, display_name, password_salt, password_hash, role, status
    FROM users WHERE lower(username) = lower(?)
  `).get(username.trim()) as UserRow | undefined;
  const passwordValid = verifyPassword(
    password,
    row?.password_salt ?? DUMMY_PASSWORD.salt,
    row?.password_hash ?? DUMMY_PASSWORD.hash,
  );
  if (!row || row.status !== "active" || !passwordValid) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export class LoginBlockedError extends Error {}

export async function checkLocalLoginRateLimit(request: NextRequest, username: string): Promise<string> {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client = forwardedFor || request.headers.get("x-real-ip") || "local";
  const key = createHash("sha256").update(`${client}\n${username.trim().toLowerCase()}`).digest("base64url");
  const row = await getDb().prepare("SELECT blocked_until FROM auth_attempts WHERE attempt_key = ?").get(key) as
    | { blocked_until: number }
    | undefined;
  if (row && row.blocked_until > Date.now()) throw new LoginBlockedError("登录尝试过多，请 15 分钟后再试");
  return key;
}

export async function recordLocalLoginResult(attemptKey: string, succeeded: boolean): Promise<void> {
  const db = getDb();
  if (succeeded) {
    await db.prepare("DELETE FROM auth_attempts WHERE attempt_key = ?").run(attemptKey);
    return;
  }
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const row = await db.prepare("SELECT failure_count, window_started FROM auth_attempts WHERE attempt_key = ?").get(attemptKey) as
    | { failure_count: number; window_started: number }
    | undefined;
  const failureCount = !row || row.window_started <= now - windowMs ? 1 : row.failure_count + 1;
  const windowStarted = !row || row.window_started <= now - windowMs ? now : row.window_started;
  const blockedUntil = failureCount >= 5 ? now + windowMs : 0;
  await db.prepare(`
    INSERT INTO auth_attempts (attempt_key, failure_count, window_started, blocked_until) VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET
      failure_count = excluded.failure_count,
      window_started = excluded.window_started,
      blocked_until = excluded.blocked_until
  `).run(attemptKey, failureCount, windowStarted, blockedUntil);
}

export async function createSession(userId: string, request: NextRequest | Request): Promise<void> {
  await cleanExpiredSecurityRows();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? "";
  await getDb().prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, created_at, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionHash(token), userId, expiresAt, Date.now(), userAgent);

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto ? forwardedProto === "https" : new URL(request.url).protocol === "https:";
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sessionHash(token));
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  await cleanExpiredSecurityRows();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sessionHash(token), Date.now()) as Pick<UserRow, "id" | "username" | "display_name" | "role" | "status"> | undefined;
  if (!row || row.status !== "active") return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export async function requirePageUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(await isInitialized() ? "/login" : "/setup");
  return user;
}

export async function requirePageAdmin(): Promise<SessionUser> {
  const user = await requirePageUser();
  if (user.role !== "admin") redirect("/console");
  return user;
}

export async function recordAudit(
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
  database: HumDatabase = getDb(),
): Promise<void> {
  await database.prepare(`
    INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorUserId, action, targetType, targetId, JSON.stringify(detail), Date.now());
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}, actorUserId: string): Promise<SessionUser> {
  const username = input.username.trim();
  const displayName = input.displayName.trim() || username;
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error("账号格式无效");
  if (input.password.length < 10 || input.password.length > 128) throw new Error("密码长度需为 10–128 位");
  if (!(["admin", "approver", "uploader"] as string[]).includes(input.role)) throw new Error("角色无效");
  const password = hashPassword(input.password);
  const user: SessionUser = { id: randomUUID(), username, displayName, role: input.role };
  const now = Date.now();
  await getDb().prepare(`
    INSERT INTO users (id, username, display_name, password_salt, password_hash, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(user.id, user.username, user.displayName, password.salt, password.hash, user.role, now, now);
  await recordAudit(actorUserId, "user.create", "user", user.id, { username: user.username, role: user.role });
  return user;
}

export async function updateProfile(userId: string, input: { displayName?: string; currentPassword?: string; newPassword?: string }): Promise<void> {
  const db = getDb();
  const row = await db.prepare("SELECT password_salt, password_hash FROM users WHERE id = ?").get(userId) as
    | { password_salt: string; password_hash: string }
    | undefined;
  if (!row) throw new Error("用户不存在");
  const displayName = input.displayName?.trim();
  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 80)) throw new Error("显示名称需为 1–80 个字符");
  if (input.newPassword) {
    if (!input.currentPassword || !verifyPassword(input.currentPassword, row.password_salt, row.password_hash)) {
      throw new Error("当前密码不正确");
    }
    if (input.newPassword.length < 10 || input.newPassword.length > 128) throw new Error("新密码长度需为 10–128 位");
    const password = hashPassword(input.newPassword);
    await db.prepare("UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?").run(password.salt, password.hash, Date.now(), userId);
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
  if (displayName !== undefined) {
    await db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(displayName, Date.now(), userId);
  }
  await recordAudit(userId, "user.profile.update", "user", userId, { displayNameChanged: displayName !== undefined, passwordChanged: Boolean(input.newPassword) });
}

