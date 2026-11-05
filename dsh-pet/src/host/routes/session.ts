/**
 * 会话跳转：把「切到某条会话」的意图写进 `sections.focusSession`，由页面自己消费。
 *
 * 桌面宠物跑在独立渲染进程里，拿不到页面中的会话服务，只能由宿主中转这一次；
 * 写入带 `ts`，消费端据此判断信号是否已处理——页面晚于写入加载时仍能重放一次。
 * 只校验输入并写状态，不判断会话是否存在（那是页面的事），也不碰任何既有叶子。
 *
 * 另有 session-binding（读 / 写会话绑定）与 session-binding/sessions（给桌面 Helper 列会话）：
 * Helper 是独立 Electron 窗口，拿不到 DSH 客户端容器里的 sessions / workspaces 服务，
 * 会话枚举由宿主经 sessionQuery（dsh-session-query）与 workspaceRegistry（dsh-workspace）软取拼装，
 * 行形状与过滤规则同网页端（共用 shared/session-list 的 SessionRow 投影）。
 * @module dsh-pet/src/host/routes/session
 */
import type { RouteResult } from '../http.ts';
import { readSessionBinding, writeSessionBinding } from '../config/session-binding.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { SessionRow, WorkspaceSnapshotLike } from '../../shared/session-list.ts';

/** 会话 id 上限：DSH 的 id 形如 `session-<uuid>`（44 字符），128 已足够，更长的视为伪造输入。 */
const MAX_SESSION_ID_CHARS = 128;

/** 宿主在「还没有会话」时写进快照的哨兵值，不能当作跳转目标。 */
const UNKNOWN_SESSION_ID = 'unknown';

/** dsh-session-query 的最小形状（软取；缺 listSessions / readTitleSnapshots 时按不可用降级）。 */
interface SessionQueryLike {
  listSessions?: (signal?: AbortSignal) => Promise<unknown>;
  readTitleSnapshots?: (sessionIds: readonly string[], signal?: AbortSignal) => Promise<unknown>;
}

/** workspaceRegistry 的最小形状（软取；list / archivedSessionIds 取不到时按不可用降级）。 */
interface WorkspaceRegistryLike {
  list?: () => unknown;
  readonly archivedSessionIds?: unknown;
}

/**
 * 会话领域：未命中返回 undefined，命中返回应答。
 *
 * @param deps - 路由依赖；本领域读 `state` 与可选服务（sessionQuery / workspaceRegistry）。
 * @param input - 本次请求。
 * @returns 命中则应答，否则 undefined 交给下一个处理器。
 */
export async function handleSessionRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 必须写成正向比较：check:openapi 只扫描正向分支，反向守卫它看不见（注释里也不要写那种形式的字面量）。
  const isSessionBinding = input.rest === 'session-binding';
  if (isSessionBinding) return handleSessionBinding(deps, input);
  const isSessionList = input.rest === 'session-binding/sessions';
  if (isSessionList) return handleSessionList(deps, input);
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

/**
 * 会话列表（GET /session-binding/sessions）：给桌面 Helper 的右键「DSH 会话」子菜单用。
 *
 * Helper 拿不到客户端容器里的 sessions / workspaces 服务，这里用宿主侧同容器服务拼一份
 * 与网页端同形状的数据：sessionQuery 枚举 + 批量读标题，workspaceRegistry 给分组与归档名单，
 * 绑定一并带回（Helper 打开菜单一次 GET 拿全）。分组与过滤在消费端做（shared/session-list 共用一份）。
 *
 * 降级：sessionQuery 缺失或调用失败 → available:false + 空列表（Helper 隐藏该菜单项）；
 * workspaceRegistry 缺失 / 失败 → workspaces:null（消费端按 cwd 启发式分组）。
 * 已知取舍：宿主侧拿不到 blank / retainedBy（客户端概念），未命名占位会话不会被过滤，
 * 空标题由消费端回落成 id 前 8 位显示。
 */
async function handleSessionList(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method !== 'GET') return methodNotAllowed();
  const binding = readSessionBinding(deps.configPaths) ?? { sessionId: '', enabled: false };
  const optionalService = typeof deps.optionalService === 'function' ? deps.optionalService : () => undefined;
  const query = optionalService('sessionQuery') as SessionQueryLike | undefined;
  if (!query || typeof query.listSessions !== 'function') {
    return okResult({ ok: true, available: false, sessions: [], workspaces: null, sessionBinding: binding });
  }

  let records: unknown;
  try {
    records = await query.listSessions(input.signal);
  } catch (error) {
    deps.ctx?.logger?.warn?.('[dsh-xiaojing] session-binding/sessions: listSessions 失败 ' + describeError(error));
    return okResult({ ok: true, available: false, sessions: [], workspaces: null, sessionBinding: binding });
  }

  // 每条 record 形如 { header, formatStatus }；只认 header.id 是字符串的行（防御上游形状变化）。
  const headers: { id: string; cwd?: string; createdAt?: number; parentSession?: string; origin?: string }[] = [];
  for (const record of Array.isArray(records) ? records : []) {
    const header = (record as { header?: unknown } | null)?.header;
    if (!header || typeof header !== 'object') continue;
    const h = header as {
      id?: unknown;
      createdAt?: unknown;
      cwd?: unknown;
      parentSession?: unknown;
      origin?: unknown;
    };
    if (typeof h.id !== 'string' || h.id === '') continue;
    headers.push({
      id: h.id,
      cwd: typeof h.cwd === 'string' && h.cwd !== '' ? h.cwd : undefined,
      createdAt: typeof h.createdAt === 'number' ? h.createdAt : undefined,
      parentSession: typeof h.parentSession === 'string' && h.parentSession !== '' ? h.parentSession : undefined,
      origin: typeof h.origin === 'string' ? h.origin : undefined,
    });
  }

  // 标题批量读一次（readTitleSnapshots 按 sessionIds 顺序回 [{status,value:{session,title?}}]）。
  // 失败不致命：标题留空，消费端 sessionTitle 回落 id 前 8 位。
  const titles = new Map<string, string>();
  if (headers.length > 0 && typeof query.readTitleSnapshots === 'function') {
    try {
      const snapshots = (await query.readTitleSnapshots(
        headers.map((h) => h.id),
        input.signal,
      )) as unknown;
      for (const one of Array.isArray(snapshots) ? snapshots : []) {
        const value = (one as { status?: unknown; value?: unknown } | null)?.value;
        if (!value || typeof value !== 'object') continue;
        const v = value as { session?: { id?: unknown }; title?: unknown };
        if (typeof v.session?.id !== 'string') continue;
        const title = readTitleText(v.title);
        if (title === '') continue;
        // 快照里的 session.id 与 list 里的 id 未必同一写法（会话日志头存裸 uuid，list 带 `session-`
        // 前缀），三种写法都记一份，后面按行 id 取，取不到就回落 id 前 8 位。
        const bare = v.session.id.replace(/^session-/u, '');
        titles.set(v.session.id, title);
        titles.set(bare, title);
        titles.set('session-' + bare, title);
      }
    } catch (error) {
      deps.ctx?.logger?.warn?.(
        '[dsh-xiaojing] session-binding/sessions: readTitleSnapshots 失败 ' + describeError(error),
      );
    }
  }

  const rows: SessionRow[] = headers.map((h) => ({
    id: h.id,
    title: titles.get(h.id) ?? titles.get(h.id.replace(/^session-/u, '')) ?? '',
    cwd: h.cwd,
    updatedAt: h.createdAt,
    parentSessionId: h.parentSession,
    origin: h.origin,
  }));

  return okResult({
    ok: true,
    available: true,
    sessions: rows,
    workspaces: readWorkspaceSnapshot(deps),
    sessionBinding: binding,
  });
}

/** 软取 workspaceRegistry：list() + archivedSessionIds 拼成与网页端快照同形状的投影；任何一步失败返回 null。 */
function readWorkspaceSnapshot(deps: PetRouteDeps): WorkspaceSnapshotLike | null {
  const optionalService = typeof deps.optionalService === 'function' ? deps.optionalService : () => undefined;
  const registry = optionalService('workspaceRegistry') as WorkspaceRegistryLike | undefined;
  if (!registry || typeof registry.list !== 'function') return null;
  try {
    const entities = registry.list();
    if (!Array.isArray(entities)) return null;
    const items = [];
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object') continue;
      const e = entity as { id?: unknown; title?: unknown; path?: unknown; sessionIds?: unknown };
      if (typeof e.id !== 'string' || e.id === '') continue;
      if (!Array.isArray(e.sessionIds)) continue;
      items.push({
        workspaceId: e.id,
        path: typeof e.path === 'string' && e.path !== '' ? e.path : undefined,
        title: typeof e.title === 'string' ? e.title : '',
        sessionIds: e.sessionIds.filter((id): id is string => typeof id === 'string'),
      });
    }
    const archivedRaw = registry.archivedSessionIds;
    const archivedSessionIds = Array.isArray(archivedRaw)
      ? archivedRaw.filter((id): id is string => typeof id === 'string')
      : [];
    return { items, archivedSessionIds };
  } catch {
    return null;
  }
}

/** 错误转短文案（日志用，不外泄细节）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从标题快照里取出文本。
 *
 * 不同版本 / 不同服务给的形状不一样：有的是裸字符串，有的是快照对象（`{title, messageSeqs, …}`
 * 或 `{value}`）。这里逐层取文本，取不到返回空串——调用方按「无标题」处理。
 */
function readTitleText(raw: unknown): string {
  let value = raw;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const next = value as { title?: unknown; value?: unknown; text?: unknown };
    if (typeof next.title === 'string') return next.title.trim();
    if (typeof next.value === 'string') return next.value.trim();
    if (typeof next.text === 'string') return next.text.trim();
    value = next.title ?? next.value;
  }
  return '';
}
