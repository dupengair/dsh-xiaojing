/**
 * `POST /chat` 接入绑定会话的契约测试：纯文本优先投会话，未绑定回落桌宠直聊。
 *
 * 直接测导出的路由处理函数，不启 HTTP 服务；会话投递能力用桩代替，
 * 只断言路由的分流与透传，不重复测投递器内部（见 plugin/session-prompt.test.ts）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { PetImageRef, PetImageSink } from '../image-attachment.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { handleChatRoutes } from './chat.ts';

/** 最小 PNG 头：8 字节，足够走完准入。 */
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

/** 一次 chat 调用（老路径与绑定会话路径各记一份）。 */
type Calls = {
  legacy: { petId: string; text: string; image?: PetImageRef }[];
  session: { petId: string; text: string }[];
};

/** 造最小路由依赖；`inSession` 缺省 = 这份 deps 不认识 chatInSession（现有测试的形状）。 */
function makeDeps(inSession?: (petId: string, text: string) => Promise<{ ok: true; text: string } | undefined>): {
  deps: PetRouteDeps;
  calls: Calls;
} {
  const calls: Calls = { legacy: [], session: [] };
  const sink: PetImageSink = {
    saveImages: async (inputs) =>
      inputs.map((input) => ({
        attachmentId: 'sha256:' + 'a'.repeat(64),
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 8,
        height: 8,
      })),
  };
  const deps = {
    configPaths: {},
    log: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} },
    memoryPath: '/tmp/dsh-pet-memory.json',
    memoryRounds: () => 5,
    readMemory: async () => ({}),
    requirePet: () => ({ ok: true, petId: 'main', entry: 'main', conf: {} }),
    optionalService: (name: string) => (name === 'attachments' ? sink : undefined),
    chatWithPet: async (petId: string, text: string, image?: PetImageRef) => {
      calls.legacy.push({ petId, text, image });
      return { ok: true as const, text: '桌宠直聊' };
    },
    chatInSession:
      inSession === undefined
        ? undefined
        : async (petId: string, text: string) => {
            calls.session.push({ petId, text });
            return inSession(petId, text);
          },
  } as unknown as PetRouteDeps;
  return { deps, calls };
}

/** 一次 POST /chat；URL 只是占位，pet 由 requirePet 桩决定。 */
function postChat(body: unknown): RouteInput {
  return {
    url: new URL('http://127.0.0.1/dsh-pet-7340/chat?pet=main&surface=web'),
    rest: 'chat',
    method: 'POST',
    body: JSON.stringify(body),
  };
}

/** 从 RouteResult 里取 JSON 体（断言用）。 */
function jsonBody(result: Awaited<ReturnType<typeof handleChatRoutes>>): Record<string, unknown> {
  assert.equal(result?.kind, 'json');
  return (result as { obj: Record<string, unknown> }).obj;
}

describe('POST /chat 的绑定会话分流', () => {
  test('deps 没带 chatInSession：走老路径，chatWithPet 收到正文', async () => {
    const { deps, calls } = makeDeps();
    const body = jsonBody(await handleChatRoutes(deps, postChat({ text: '在吗' })));
    assert.equal(body.ok, true);
    assert.equal(body.text, '桌宠直聊');
    assert.deepEqual(calls.legacy, [{ petId: 'main', text: '在吗', image: undefined }]);
  });

  test('绑定了但投递拿不到回复（undefined）：回落 chatWithPet', async () => {
    const { deps, calls } = makeDeps(async () => undefined);
    const body = jsonBody(await handleChatRoutes(deps, postChat({ text: '在吗' })));
    assert.equal(body.text, '桌宠直聊');
    assert.equal(calls.session.length, 1);
    assert.deepEqual(calls.legacy, [{ petId: 'main', text: '在吗', image: undefined }]);
  });

  test('绑定会话拿到回复：直接返回，不再调 chatWithPet', async () => {
    const { deps, calls } = makeDeps(async () => ({ ok: true, text: '会话里回的' }));
    const body = jsonBody(await handleChatRoutes(deps, postChat({ text: '在吗' })));
    assert.equal(body.ok, true);
    assert.equal(body.text, '会话里回的');
    assert.deepEqual(calls.session, [{ petId: 'main', text: '在吗' }]);
    assert.equal(calls.legacy.length, 0);
  });

  test('带图：不投会话，仍走老路径并把图片引用透传下去', async () => {
    const { deps, calls } = makeDeps(async () => ({ ok: true, text: '不该走到这' }));
    const body = jsonBody(
      await handleChatRoutes(
        deps,
        postChat({ text: '看图', attachment: { mediaType: 'image/png', data: PNG_BASE64 } }),
      ),
    );
    assert.equal(body.text, '桌宠直聊');
    assert.equal(calls.session.length, 0);
    assert.equal(calls.legacy.length, 1);
    assert.match(String(calls.legacy[0]?.image?.attachmentId), /^sha256:/);
  });
});
