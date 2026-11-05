/**
 * DSH 会话绑定（sessionBinding）：桌宠面板 ↔ 一条 DSH 会话 的全局绑定关系。
 *
 * 存放位置：用户主配置文件的顶层 `sessionBinding` 字段（不在 GLOBAL_DEFAULT_KEYS 白名单里，
 * 合并层不透传——读取直接走用户层原对象，保存设置时由 saveUserConfig 的透传保留兜住）。
 * @module dsh-pet/src/host/config/session-binding
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { effectiveUserFile, readUserConfig } from './jsonc.ts';
import { setJsoncTopLevelValue } from './jsonc-edit.ts';
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
 * 写绑定：只替换用户主配置里 `sessionBinding` 那一段字符。
 *
 * 走 JSONC 定点改写（src/host/config/jsonc-edit.ts）：用户手写的 `//` 注释、缩进、键顺序都留得住。
 * 文件不存在 → 按普通 JSON 新建一份；文件存在但改不动（结构可疑 / 校验不通过）
 * → 抛错、不写盘，让上层的请求失败而不是悄悄把用户配置抹平。
 */
export function writeSessionBinding(paths: ConfigPaths, binding: SessionBinding): void {
  const file = effectiveUserFile(paths) ?? paths.userFile;
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  mkdirSync(dirname(file), { recursive: true });
  if (raw === undefined || raw.trim() === '') {
    // 还没有用户层文件：写一份只有绑定字段的最小结构（之后合并层会补默认值）
    writeFileSync(file, JSON.stringify({ sessionBinding: binding }, null, 2) + '\n', 'utf8');
    return;
  }
  writeFileSync(file, setJsoncTopLevelValue(raw, 'sessionBinding', binding), 'utf8');
}
