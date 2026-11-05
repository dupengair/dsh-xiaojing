/**
 * 会话跳转：把「切到某条会话」的意图写进 `sections.focusSession`，由页面自己消费。
 *
 * 桌面宠物跑在独立渲染进程里，拿不到页面中的会话服务，只能由宿主中转这一次；
 * 写入带 `ts`，消费端据此判断信号是否已处理——页面晚于写入加载时仍能重放一次。
 * 只校验输入并写状态，不判断会话是否存在（那是页面的事），也不碰任何既有叶子。
 * @module dsh-pet/src/host/routes/session
 */
import type { RouteResult } from '../http.ts';
import { readSessionBinding, writeSessionBinding } from '../config/session-binding.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 会话 id 上限：DSH 的 id 形如 `session-<uuid>`（44 字符），128 已足够，更长的视为伪造输入。 */
const MAX_SESSION_ID_CHARS = 128;

/** 宿主在「还没有会话」时写进快照的哨兵值，不能当作跳转目标。 */
const UNKNOWN_SESSION_ID = 'unknown';

/**
 * 会话领域：未命中返回 undefined，命中返回应答。
 *
 * @param deps - 路由依赖；本领域只读 `state`。
 * @param input - 本次请求。
 * @returns 命中则应答，否则 undefined 交给下一个处理器。
 */
export async function handleSessionRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 必须写成正向比较：check:openapi 只扫描正向分支，反向守卫它看不见（注释里也不要写那种形式的字面量）。
  const isSessionBinding = input.rest === 'session-binding';
  if (isSessionBinding) return handleSessionBinding(deps, input);
  const isFocusSession = input.rest === 'focus-session';
  if (!isFocusSession) return undefined;
  if (input.method !== 'POST') return methodNotAllowed();

  let payload: { sessionId?: unknown } | null;
  try {
    payload = JSON.parse(input.body ?? '') as { sessionId?: unknown } | null;
  } catch {
    return invalidJson();
  }

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (sessionId === '' || sessionId === UNKNOWN_SESSION_ID) return failResult('bad-request', 'sessionId 必填');
  if (sessionId.length > MAX_SESSION_ID_CHARS) {
    return failResult('bad-request', `sessionId 超过 ${MAX_SESSION_ID_CHARS} 字符`);
  }

  const ts = Date.now();
  deps.state.writeSection('focusSession', { sessionId, ts });
  return okResult({ ok: true, sessionId, ts });
}

/**
 * 会话绑定（session-binding）：GET 读当前绑定，POST 改绑 / 解绑。
 * 绑定存用户主配置顶层（写入只替换 sessionBinding 一个键，见 config/session-binding）。
 */
async function handleSessionBinding(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method === 'GET') {
    // 未绑定时回空 sessionId + enabled:false，客户端不用区分「没写」与「写坏了」
    const binding = readSessionBinding(deps.configPaths) ?? { sessionId: '', enabled: false };
    return okResult({ ok: true, sessionBinding: binding });
  }
  if (input.method !== 'POST') return methodNotAllowed();
  let payload: { sessionId?: unknown; enabled?: unknown } | null;
  try {
    payload = JSON.parse(input.body ?? '') as { sessionId?: unknown; enabled?: unknown } | null;
  } catch {
    return invalidJson();
  }
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const enabled = payload?.enabled === true;
  if (enabled) {
    // 绑定时 id 必须是合法会话 id（与 focus-session 同一口径）
    if (sessionId === '' || sessionId === UNKNOWN_SESSION_ID) return failResult('bad-request', 'sessionId 必填');
    if (sessionId.length > MAX_SESSION_ID_CHARS) {
      return failResult('bad-request', `sessionId 超过 ${MAX_SESSION_ID_CHARS} 字符`);
    }
  }
  // 解绑（enabled:false）不要求带 id：写成空 id + 关闭，读取侧一律按未绑定处理
  const binding = enabled ? { sessionId, enabled: true } : { sessionId: '', enabled: false };
  try {
    writeSessionBinding(deps.configPaths, binding);
  } catch (error) {
    return failResult('generate-error', '写入配置失败：' + (error instanceof Error ? error.message : String(error)));
  }
  return okResult({ ok: true, sessionBinding: binding });
}
