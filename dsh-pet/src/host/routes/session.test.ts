/**
 * 会话跳转端点（`POST /focus-session`）与会话列表端点（`GET /session-binding/sessions`）：出入参分档与写入。
 *
 * 只测端点自己的判断和结果；页面怎么消费信号、Helper 怎么分组不在本文件范围。
 * 跑法：node --experimental-strip-types --test src/host/routes/session.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleSessionRoutes } from './session.ts';
import { PollStateStore } from '../state.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps } from './types.ts';

/** 路由只用到 state，其余依赖本领域不读，测试里不构造。 */
function makeDeps(): { deps: PetRouteDeps; state: PollStateStore } {
  const state = new PollStateStore();
  return { deps: { state } as unknown as PetRouteDeps, state };
}

/** 会话列表端点的依赖：真 configPaths（临时目录）+ 可注入的 optionalService 假实现。 */
function makeListDeps(services: Record<string, unknown>): { deps: PetRouteDeps; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-session-test-'));
  const deps = {
    state: new PollStateStore(),
    configPaths: {
      defaultFile: join(dir, 'default.jsonc'),
      userFile: join(dir, 'main-config.jsonc'),
      petDir: join(dir, 'pet'),
    },
    optionalService: (name: string) => services[name],
  } as unknown as PetRouteDeps;
  return { deps, dir };
}

/** 调一次端点；`rest` 默认是干净的 `focus-session`。 */
function call(
  deps: PetRouteDeps,
  method: string,
  body?: string,
  rest = 'focus-session',
): Promise<RouteResult | undefined> {
  return handleSessionRoutes(deps, { url: new URL('http://localhost/focus-session'), rest, method, body });
}

/** 断言是 JSON 应答并取出状态码与响应体。 */
function asJson(result: RouteResult | undefined): { status: number; obj: Record<string, unknown> } {
  assert.ok(result !== undefined, '处理器应给出应答');
  assert.equal(result.kind, 'json');
  return { status: result.status, obj: result.obj as Record<string, unknown> };
}

describe('handleSessionRoutes —— 路径与方法', () => {
  test('非 focus-session 路径 → undefined（交给下一个处理器）', async () => {
    const { deps } = makeDeps();
    assert.equal(await call(deps, 'POST', '{}', 'other'), undefined);
  });

  test('非 POST → 405', async () => {
    const { deps } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'GET'));
    assert.equal(status, 405);
    assert.equal(obj.reason, 'method-not-allowed');
  });
});

describe('handleSessionRoutes —— 输入校验', () => {
  test('请求体不是 JSON → 400 invalid-json', async () => {
    const { deps } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'POST', 'not json'));
    assert.equal(status, 400);
    assert.equal(obj.reason, 'invalid-json');
  });

  test('缺 sessionId → bad-request，且不写叶子', async () => {
    const { deps, state } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'POST', '{}'));
    assert.equal(status, 200);
    assert.equal(obj.reason, 'bad-request');
    assert.equal(state.read().sections.focusSession.data, null, '校验失败不该留下半条信号');
  });

  test('sessionId 为空串 / 纯空白 / unknown → bad-request', async () => {
    const { deps } = makeDeps();
    for (const body of ['{"sessionId":""}', '{"sessionId":"   "}', '{"sessionId":"unknown"}']) {
      assert.equal(asJson(await call(deps, 'POST', body)).obj.reason, 'bad-request');
    }
  });

  test('sessionId 不是字符串 → bad-request', async () => {
    const { deps } = makeDeps();
    assert.equal(asJson(await call(deps, 'POST', '{"sessionId":42}')).obj.reason, 'bad-request');
  });

  test('sessionId 超过 128 字符 → bad-request', async () => {
    const { deps } = makeDeps();
    const body = JSON.stringify({ sessionId: 'x'.repeat(129) });
    assert.equal(asJson(await call(deps, 'POST', body)).obj.reason, 'bad-request');
  });
});

describe('handleSessionRoutes —— 写 sections.focusSession', () => {
  test('成功 → 200 ok，并把 sessionId 与 ts 写进快照', async () => {
    const { deps, state } = makeDeps();
    const { status, obj } = asJson(await call(deps, 'POST', '{"sessionId":"session-abc"}'));
    assert.equal(status, 200);
    assert.equal(obj.ok, true);
    const leaf = state.read().sections.focusSession;
    assert.deepEqual(leaf.data, { sessionId: 'session-abc', ts: obj.ts });
    assert.ok(leaf.counter > 0, '写入必须推进 counter，否则页面拿不到变化');
  });

  test('首尾空白被裁掉后落库', async () => {
    const { deps, state } = makeDeps();
    await call(deps, 'POST', '{"sessionId":"  session-abc  "}');
    const data = state.read().sections.focusSession.data as { sessionId: string };
    assert.equal(data.sessionId, 'session-abc');
  });

  test('连续两次 → 后一次覆盖前一次，ts 不回退', async () => {
    const { deps, state } = makeDeps();
    await call(deps, 'POST', '{"sessionId":"session-one"}');
    const first = state.read().sections.focusSession.data as { ts: number };
    await call(deps, 'POST', '{"sessionId":"session-two"}');
    const second = state.read().sections.focusSession.data as { sessionId: string; ts: number };
    assert.equal(second.sessionId, 'session-two');
    assert.ok(second.ts >= first.ts, 'ts 用于消费端判重，不允许回退');
  });
});

describe('handleSessionRoutes —— GET session-binding/sessions', () => {
  test('非 GET → 405', async () => {
    const { deps } = makeListDeps({ sessionQuery: { listSessions: async () => [] } });
    const { status, obj } = asJson(await call(deps, 'POST', '{}', 'session-binding/sessions'));
    assert.equal(status, 405);
    assert.equal(obj.reason, 'method-not-allowed');
  });

  test('缺 sessionQuery 服务 → 200 available:false 空列表（Helper 隐藏菜单项）', async () => {
    const { deps } = makeListDeps({});
    const { status, obj } = asJson(await call(deps, 'GET', undefined, 'session-binding/sessions'));
    assert.equal(status, 200);
    assert.equal(obj.ok, true);
    assert.equal(obj.available, false);
    assert.deepEqual(obj.sessions, []);
    assert.equal(obj.workspaces, null);
    assert.deepEqual(obj.sessionBinding, { sessionId: '', enabled: false });
  });

  test('listSessions 抛错 → available:false 不 5xx', async () => {
    const { deps } = makeListDeps({
      sessionQuery: {
        listSessions: async () => {
          throw new Error('boom');
        },
      },
    });
    const { status, obj } = asJson(await call(deps, 'GET', undefined, 'session-binding/sessions'));
    assert.equal(status, 200);
    assert.equal(obj.available, false);
  });

  test('正常路径：header 投影 + 标题批量 + 工作区投影 + 回读绑定', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dsh-pet-session-test-')), '');
    const { deps } = makeListDeps({
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'session-aaa', createdAt: 200, cwd: 'D:\\work\\a', parentSession: null, origin: undefined } },
          { header: { id: 'session-bbb', createdAt: 100, cwd: undefined } }, // 无 cwd：行仍列出（分组交给消费端）
          null, // 脏行：非对象 record
          { header: { id: '', createdAt: 1 } }, // 脏行：id 空串
          { header: { id: 42 } }, // 脏行：id 非字符串
        ],
        readTitleSnapshots: async () => [
          { status: 'fulfilled', value: { session: { id: 'session-aaa' }, title: '标题 A' } },
          { status: 'fulfilled', value: { session: { id: 'session-bbb' }, title: '   ' } }, // 纯空白标题 → 留空
        ],
      },
      workspaceRegistry: {
        list: () => [{ id: 'ws1', title: '工作区一', path: 'D:\\work\\a', sessionIds: ['session-aaa'] }],
        archivedSessionIds: ['session-zzz', 7],
      },
    });
    // 预置绑定：验证 GET 一起带回
    writeFileSync(
      (deps.configPaths as { userFile: string }).userFile,
      JSON.stringify({ sessionBinding: { sessionId: 'session-aaa', enabled: true } }),
      'utf8',
    );
    const { status, obj } = asJson(await call(deps, 'GET', undefined, 'session-binding/sessions'));
    assert.equal(status, 200);
    assert.equal(obj.available, true);
    assert.deepEqual(obj.sessions, [
      {
        id: 'session-aaa',
        title: '标题 A',
        cwd: 'D:\\work\\a',
        updatedAt: 200,
        parentSessionId: undefined,
        origin: undefined,
      },
      { id: 'session-bbb', title: '', cwd: undefined, updatedAt: 100, parentSessionId: undefined, origin: undefined },
    ]);
    assert.deepEqual(obj.workspaces, {
      items: [{ workspaceId: 'ws1', path: 'D:\\work\\a', title: '工作区一', sessionIds: ['session-aaa'] }],
      archivedSessionIds: ['session-zzz'],
    });
    assert.deepEqual(obj.sessionBinding, { sessionId: 'session-aaa', enabled: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test('缺 readTitleSnapshots / 标题抛错 → 标题留空，不失败', async () => {
    const { deps } = makeListDeps({
      sessionQuery: {
        listSessions: async () => [{ header: { id: 'session-ccc', createdAt: 5 } }],
        // readTitleSnapshots 缺失：走不到标题分支
      },
    });
    const { obj } = asJson(await call(deps, 'GET', undefined, 'session-binding/sessions'));
    assert.equal(obj.available, true);
    assert.deepEqual(obj.sessions, [
      { id: 'session-ccc', title: '', cwd: undefined, updatedAt: 5, parentSessionId: undefined, origin: undefined },
    ]);
  });

  test('workspaceRegistry 抛错 → workspaces:null（消费端走 cwd 启发式）', async () => {
    const { deps } = makeListDeps({
      sessionQuery: { listSessions: async () => [{ header: { id: 'session-x' } }] },
      workspaceRegistry: {
        list: () => {
          throw new Error('boom');
        },
        archivedSessionIds: [],
      },
    });
    const { obj } = asJson(await call(deps, 'GET', undefined, 'session-binding/sessions'));
    assert.equal(obj.available, true);
    assert.equal(obj.workspaces, null);
  });

  test('deps 没有 optionalService 字段 → 不抛，按缺服务降级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-session-test-'));
    const deps = {
      state: new PollStateStore(),
      configPaths: { userFile: join(dir, 'x.jsonc') },
    } as unknown as PetRouteDeps;
    const { status, obj } = asJson(await call(deps, 'GET', undefined, 'session-binding/sessions'));
    assert.equal(status, 200);
    assert.equal(obj.available, false);
    rmSync(dir, { recursive: true, force: true });
  });
});
