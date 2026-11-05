/**
 * DSH 会话绑定（sessionBinding）：桌宠面板 ↔ 一条 DSH 会话 的全局绑定关系。
 *
 * 存放位置：用户主配置文件的顶层 `sessionBinding` 字段（不在 GLOBAL_DEFAULT_KEYS 白名单里，
 * 合并层不透传——读取直接走用户层原对象，保存设置时由 saveUserConfig 的透传保留兜住）。
 * @module dsh-pet/src/host/config/session-binding
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readUserConfig } from './jsonc.ts';
import type { ConfigPaths } from './constants.ts';

/** 绑定关系：sessionId 为空串 = 未绑定（enabled 必为 false）。 */
export interface SessionBinding {
  readonly sessionId: string;
  readonly enabled: boolean;
}

/** 与 routes/session.ts 的 focus-session 同口径（不 import 路由层，避免反向依赖）。 */
const MAX_SESSION_ID_CHARS = 128;

/** 把配置里的原始值收窄成绑定关系；形状不对（缺 id / 非对象）返回 null = 未绑定。 */
function normalize(raw: unknown): SessionBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { sessionId?: unknown; enabled?: unknown };
  if (typeof o.sessionId !== 'string') return null;
  const sessionId = o.sessionId.trim();
  if (sessionId === '' || sessionId.length > MAX_SESSION_ID_CHARS) return null;
  return { sessionId, enabled: o.enabled === true };
}

/** 读当前绑定：用户层没写（或写得不对）→ null。 */
export function readSessionBinding(paths: ConfigPaths): SessionBinding | null {
  return normalize(readUserConfig(paths)?.sessionBinding);
}

/**
 * 写绑定：读用户层原对象 → 只替换 `sessionBinding` 一个键 → 整份写回主配置文件。
 * 已知取舍：JSON.stringify 会丢掉用户在 jsonc 里手写的注释（只在面板改绑定时发生一次）；
 * 其余字段原样带回，不碰设置页的白名单字段。
 */
export function writeSessionBinding(paths: ConfigPaths, binding: SessionBinding): void {
  const user = readUserConfig(paths) ?? {};
  const next = { ...user, sessionBinding: binding };
  mkdirSync(dirname(paths.userFile), { recursive: true });
  writeFileSync(paths.userFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
}
