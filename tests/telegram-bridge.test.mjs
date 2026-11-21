import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramHitlBridge, maskBotToken } from '../openrig/lib/telegram-bridge.mjs';

test('TelegramHitlBridge sends parsed inline buttons, executes authorized callback, and blocks unauthorized chats', async () => {
  const apiCalls = [];
  const executed = [];

  const mockFetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body || '{}');
    apiCalls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } })
    };
  };

  const bridge = new TelegramHitlBridge({
    botToken: '123456:ABC-DEF-SECRET-TOKEN',
    chatId: '99887766',
    fetchImpl: mockFetch,
    onExecuteAction: async (act) => {
      executed.push(act);
      return { ok: true };
    }
  });

  assert.equal(maskBotToken('123456:ABC-DEF-SECRET-TOKEN'), '12345…OKEN');
  assert.equal(bridge.getStatus().configured, true);

  // 1. Notify HITL prompt -> registers 3 parsed options + 1 Ctrl+C button
  const screen = [
    'Allow running negative control?',
    '› 1. Yes, allow once (y)',
    '  2. Always allow in worktree',
    '  3. No, cancel (esc)'
  ].join('\n');
  const sent = await bridge.notifyHitlPrompt('dev-check@rig', screen, 1_700_000_000_000);
  assert.equal(sent.ok, true);
  assert.equal(apiCalls[0].method, 'sendMessage');
  const rows = apiCalls[0].body.reply_markup.inline_keyboard;
  assert.equal(rows.length, 4); // 3 parsed + 1 Ctrl+C
  const option1Callback = rows[0][0].callback_data;
  assert.ok(option1Callback.startsWith('hitl:'));

  // 2. Deduplication prevents spam for same prompt within 5 minutes
  const dup = await bridge.notifyHitlPrompt('dev-check@rig', screen, 1_700_000_010_000);
  assert.equal(dup.deduplicated, true);

  // 3. Unauthorized chat attempting to click the button is blocked
  const unauth = await bridge.handleUpdate({
    callback_query: {
      id: 'cq-bad',
      data: option1Callback,
      message: { message_id: 42, chat: { id: 11111111 } }
    }
  }, 1_700_000_020_000);
  assert.equal(unauth.unauthorized, true);
  assert.equal(executed.length, 0);
  assert.equal(bridge.getStatus().stats.blockedUnauthorized, 1);

  // 4. Authorized operator clicks option 1 -> executes tmux keystroke and consumes nonce (single-use)
  const okClick = await bridge.handleUpdate({
    callback_query: {
      id: 'cq-ok',
      data: option1Callback,
      message: { message_id: 42, chat: { id: 99887766 } }
    }
  }, 1_700_000_025_000);
  assert.equal(okClick.handled, true);
  assert.equal(okClick.ok, true);
  assert.deepEqual(executed, [{
    seatId: 'dev-check@rig',
    keyStroke: '1 Enter',
    actionId: 'answer_prompt_option',
    source: 'telegram'
  }]);

  // 5. Replaying same nonce is rejected as expired/consumed
  const replay = await bridge.handleUpdate({
    callback_query: {
      id: 'cq-replay',
      data: option1Callback,
      message: { message_id: 42, chat: { id: 99887766 } }
    }
  }, 1_700_000_030_000);
  assert.equal(replay.expired, true);
  assert.equal(executed.length, 1);
});

test('TelegramHitlBridge handles authorized /status, /stop, and /arm_breaker commands safely', async () => {
  const sentMsgs = [];
  const executed = [];
  const breakerModes = [];

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (url.endsWith('/sendMessage')) sentMsgs.push(body.text);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 100 } }) };
  };

  const bridge = new TelegramHitlBridge({
    botToken: '999:SECRET',
    chatId: '555000',
    fetchImpl: mockFetch,
    getFleetSummary: async (kind) => `SUMMARY:${kind}`,
    onExecuteAction: async (act) => { executed.push(act); return { ok: true }; },
    onBreakerModeToggle: (mode) => breakerModes.push(mode)
  });

  await bridge.handleUpdate({ message: { text: '/status', chat: { id: 555000 } } });
  await bridge.handleUpdate({ message: { text: '/stop dev-coder4@rig', chat: { id: 555000 } } });
  await bridge.handleUpdate({ message: { text: '/stop bad;inject', chat: { id: 555000 } } });
  await bridge.handleUpdate({ message: { text: '/arm_breaker', chat: { id: 555000 } } });

  assert.equal(sentMsgs[0], 'SUMMARY:status');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].seatId, 'dev-coder4@rig');
  assert.equal(executed[0].keyStroke, 'C-c');
  assert.deepEqual(breakerModes, ['auto_stop']);
});
