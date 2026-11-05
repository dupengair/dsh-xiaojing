/**
 * 绑定会话投递器（src/host/plugin/session-prompt.ts）的契约测试。
 *
 * 钉住三件事：未绑定时不投递、已绑定时按 prompt 形状投递并在 assistant + turn/end 后交出正文、
 * 投递抛错时不把错误往外冒（路由要回落到桌宠直聊）。
 * 配置用临时目录里的真实用户配置文件，绑定重读语义与生产一致。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSessionPrompt } from './session-prompt.ts';
import type { ConfigPaths } from '../config/constants.ts';

/** 等异步那一拍跑完（prompt 已被调用、等待已挂上）。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 一次 prompt 调用（断言投递形状用）。 */
type PromptCall = {
  request: {
    sessionId: string;
    requestId: string;
    mode: string;
    content: { type: string; text: string }[];
  };
  signal?: AbortSignal;
};

/** 造一份临时用户配置；binding 缺省 = 没写 sessionBinding（未绑定）。 */
function makeConfig(binding?: { sessionId: string; enabled: boolean }): { paths: ConfigPaths; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-session-prompt-'));
  const userFile = join(dir, 'main-config.jsonc');
  writeFileSync(userFile, JSON.stringify(binding === undefined ? {} : { sessionBinding: binding }), 'utf8');
  return {
    paths: { defaultFile: join(dir, 'assets.jsonc'), userFile, petDir: join(dir, 'pet') },
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 造一个 prompt 桩：记录请求，按 `fail` 决定是否抛错。 */
function makeController(options: { fail?: boolean } = {}): { service: (name: string) => unknown; calls: PromptCall[] } {
  const calls: PromptCall[] = [];
  const controller = {
    prompt: async (request: PromptCall['request'], signal?: AbortSignal) => {
      calls.push({ request, signal });
      if (options.fail === true) throw new Error('controller boom');
      return { ok: true };
    },
  };
  return { service: (name: string) => (name === 'sessionController' ? controller : undefined), calls };
}

describe('chatInSession —— 绑定会话投递', () => {
  test('未绑定：直接 undefined，不碰 sessionController', async (t) => {
    const cfg = makeConfig();
    t.after(cfg.clean);
    const { service, calls } = makeController();
    const prompt = createSessionPrompt({ configPaths: cfg.paths, service });

    assert.equal(await prompt.chatInSession('main', '在吗'), undefined);
    assert.equal(calls.length, 0);
  });

  test('绑定了但 enabled=false：同样不投递', async (t) => {
    const cfg = makeConfig({ sessionId: 's1', enabled: false });
    t.after(cfg.clean);
    const { service, calls } = makeController();
    const prompt = createSessionPrompt({ configPaths: cfg.paths, service });

    assert.equal(await prompt.chatInSession('main', '在吗'), undefined);
    assert.equal(calls.length, 0);
  });

  test('已绑定：按 queue 形状投递，assistant + turn/end 后返回正文', async (t) => {
    const cfg = makeConfig({ sessionId: 's1', enabled: true });
    t.after(cfg.clean);
    const { service, calls } = makeController();
    const prompt = createSessionPrompt({ configPaths: cfg.paths, service });

    const waiting = prompt.chatInSession('main', '在吗');
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.request.sessionId, 's1');
    assert.equal(calls[0]?.request.mode, 'queue');
    assert.deepEqual(calls[0]?.request.content, [{ type: 'text', text: '在吗' }]);
    assert.match(String(calls[0]?.request.requestId), /^[0-9a-f-]{36}$/);

    prompt.handleAssistant('s1', '在的呀');
    prompt.handleTurnEnd('s1');
    assert.deepEqual(await waiting, { ok: true, text: '在的呀' });
  });

  test('prompt 抛错：返回 undefined，不把异常泄漏给路由', async (t) => {
    const cfg = makeConfig({ sessionId: 's1', enabled: true });
    t.after(cfg.clean);
    const { service } = makeController({ fail: true });
    const logged: string[] = [];
    const prompt = createSessionPrompt({ configPaths: cfg.paths, service, log: (msg) => logged.push(msg) });

    assert.equal(await prompt.chatInSession('main', '在吗'), undefined);
    assert.equal(logged.length, 1);
    // 失败后待办已清掉：迟到的 turn/end 不该再触发任何收尾
    prompt.handleTurnEnd('s1');
  });

  test('每次调用都重读绑定：改绑前未绑定、改绑后才投递', async (t) => {
    const cfg = makeConfig();
    t.after(cfg.clean);
    const { service, calls } = makeController();
    const prompt = createSessionPrompt({ configPaths: cfg.paths, service });

    assert.equal(await prompt.chatInSession('main', '第一条'), undefined);
    writeFileSync(cfg.paths.userFile, JSON.stringify({ sessionBinding: { sessionId: 's2', enabled: true } }), 'utf8');

    const waiting = prompt.chatInSession('main', '第二条');
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.request.sessionId, 's2');
    prompt.handleAssistant('s2', '收到');
    prompt.handleTurnEnd('s2');
    assert.deepEqual(await waiting, { ok: true, text: '收到' });
  });
});
