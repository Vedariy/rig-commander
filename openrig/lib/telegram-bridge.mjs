import crypto from 'node:crypto';
import { getLiveHitlOptions } from '../assets/domain/prompt-parser.js';

/**
 * Telegram HITL & Guardrail Bridge (Zero-dependency, native Node fetch).
 * - Sends interactive inline keyboards for parsed terminal permission prompts.
 * - Authorizes callbacks and slash commands STRICTLY from the configured chatId.
 * - Uses short-lived opaque nonces (never executes arbitrary callback text).
 */

const NONCE_TTL_MS = 15 * 60_000;
const MAX_NONCES = 200;

export function maskBotToken(token) {
  const s = String(token || '').trim();
  if (!s) return '';
  if (s.length <= 10) return '****';
  return `${s.slice(0, 5)}…${s.slice(-4)}`;
}

export function buildHitlTelegramPayload(seatId, screenText, registerNonce) {
  const options = getLiveHitlOptions(screenText);
  const tailLines = String(screenText || '')
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.trim())
    .slice(-10)
    .join('\n')
    .slice(0, 900);

  const text = [
    `🚨 *RigCommander HITL — ${seatId}*`,
    '',
    '```',
    tailLines || 'Agent is awaiting terminal confirmation.',
    '```',
    options.length >= 2
      ? `Parsed ${options.length} prompt options — tap below to respond:`
      : 'Tap below to proceed, cancel, or interrupt:'
  ].join('\n');

  const keyboardRows = [];
  if (options.length >= 2) {
    for (const opt of options.slice(0, 5)) {
      const icon = opt.isCancel ? '❌' : opt.isPrimary ? '✅' : '🔹';
      const nonce = registerNonce({
        seatId,
        keyStroke: opt.keyStroke,
        actionId: opt.isCancel ? 'cancel_prompt' : 'answer_prompt_option',
        label: `${opt.badge}. ${opt.shortLabel}`
      });
      keyboardRows.push([{ text: `${icon} ${opt.badge}. ${opt.shortLabel}`, callback_data: `hitl:${nonce}` }]);
    }
  } else {
    const nProceed = registerNonce({ seatId, keyStroke: '1 Enter', actionId: 'proceed_prompt', label: '1 (Proceed)' });
    const nCancel = registerNonce({ seatId, keyStroke: 'Escape', actionId: 'cancel_prompt', label: 'Cancel (Esc)' });
    keyboardRows.push([
      { text: '✅ 1 (Proceed)', callback_data: `hitl:${nProceed}` },
      { text: '❌ Cancel (Esc)', callback_data: `hitl:${nCancel}` }
    ]);
  }

  const nStop = registerNonce({ seatId, keyStroke: 'C-c', actionId: 'interrupt_execution', label: 'Interrupt (C-c)' });
  keyboardRows.push([{ text: '🛑 Interrupt (Ctrl+C)', callback_data: `hitl:${nStop}` }]);

  return {
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboardRows }
  };
}

export class TelegramHitlBridge {
  constructor(options = {}) {
    this.botToken = String(options.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    this.chatId = String(options.chatId || process.env.TELEGRAM_CHAT_ID || '').trim();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.onExecuteAction = typeof options.onExecuteAction === 'function' ? options.onExecuteAction : null;
    this.getFleetSummary = typeof options.getFleetSummary === 'function' ? options.getFleetSummary : null;
    this.onBreakerModeToggle = typeof options.onBreakerModeToggle === 'function' ? options.onBreakerModeToggle : null;
    this.onPauseAutoConsent = typeof options.onPauseAutoConsent === 'function' ? options.onPauseAutoConsent : null;

    this.pendingNonces = new Map(); // nonce -> { seatId, keyStroke, actionId, label, expiresAt }
    this.sentPromptKeys = new Map(); // seatId -> { hash, sentAt }
    this.polling = false;
    this.pollTimer = null;
    this.lastUpdateId = 0;
    this.stats = {
      sentNotifications: 0,
      handledCallbacks: 0,
      handledCommands: 0,
      blockedUnauthorized: 0,
      lastError: null,
      lastActivityAt: null
    };
  }

  isConfigured() {
    return Boolean(this.botToken && this.chatId);
  }

  configure({ botToken, chatId }) {
    this.stopPolling();
    this.botToken = String(botToken || '').trim();
    this.chatId = String(chatId || '').trim();
    this.stats.lastError = null;
    if (this.isConfigured()) {
      this.startPolling();
    }
    return this.getStatus();
  }

  disconnect() {
    this.stopPolling();
    this.botToken = '';
    this.chatId = '';
    this.pendingNonces.clear();
    this.sentPromptKeys.clear();
    return this.getStatus();
  }

  _registerNonce(entry, nowMs = Date.now()) {
    const nonce = crypto.randomBytes(6).toString('hex');
    if (this.pendingNonces.size >= MAX_NONCES) {
      const oldestKey = this.pendingNonces.keys().next().value;
      if (oldestKey) this.pendingNonces.delete(oldestKey);
    }
    this.pendingNonces.set(nonce, { ...entry, expiresAt: nowMs + NONCE_TTL_MS });
    return nonce;
  }

  async callApi(method, body = {}) {
    if (!this.botToken) throw new Error('Telegram bot token not configured');
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch API unavailable');
    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!res.ok || !json.ok) {
      throw new Error(json.description || `Telegram API error ${res.status}`);
    }
    return json.result;
  }

  async sendText(text, extra = {}) {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    const result = await this.callApi('sendMessage', {
      chat_id: this.chatId,
      text,
      ...extra
    });
    this.stats.sentNotifications += 1;
    this.stats.lastActivityAt = new Date().toISOString();
    return { ok: true, messageId: result && result.message_id };
  }

  async sendTestMessage() {
    if (!this.isConfigured()) throw new Error('Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first');
    return this.sendText(
      '💠 *RigCommander Connected*\n\nCommands:\n• `/status` — fleet health & active seats\n• `/budget` — live token spend & circuit-breaker\n• `/stop <seat>` — emergency Ctrl+C\n• `/arm_breaker` / `/pause_breaker` — toggle auto-stop\n• `/pause_auto` — emergency pause Auto-Consent & cancel pending timers',
      { parse_mode: 'Markdown' }
    );
  }

  async notifyHitlPrompt(seatId, screenText, nowMs = Date.now()) {
    if (!this.isConfigured()) return { ok: false, skipped: true };
    const promptHash = crypto.createHash('sha1').update(`${seatId}:${String(screenText || '').slice(-400)}`).digest('hex');
    const prev = this.sentPromptKeys.get(seatId);
    if (prev && prev.hash === promptHash && nowMs - prev.sentAt < 5 * 60_000) {
      return { ok: true, deduplicated: true };
    }
    this.sentPromptKeys.set(seatId, { hash: promptHash, sentAt: nowMs });

    const payload = buildHitlTelegramPayload(seatId, screenText, (entry) => this._registerNonce(entry, nowMs));
    return this.sendText(payload.text, {
      parse_mode: payload.parse_mode,
      reply_markup: payload.reply_markup
    });
  }

  async notifyCircuitBreakerTrip(trip) {
    if (!this.isConfigured() || !trip) return { ok: false, skipped: true };
    const icon = trip.actionTaken === 'interrupted_cc' ? '🛑' : '⚠️';
    const text = [
      `${icon} *RigCommander Guardrail Triggered (${trip.severity})*`,
      `• Rule: \`${trip.rule}\``,
      `• Target: \`${trip.seatId}\``,
      `• ${trip.title}`,
      `• ${trip.detail}`,
      `• Action: \`${trip.actionTaken}\``
    ].join('\n');
    return this.sendText(text, { parse_mode: 'Markdown' });
  }

  async handleUpdate(update, nowMs = Date.now()) {
    if (!update || typeof update !== 'object') return { handled: false };

    // 1. Handle Inline Keyboard Callback Query
    if (update.callback_query) {
      const cq = update.callback_query;
      const fromChatId = String((cq.message && cq.message.chat && cq.message.chat.id) || (cq.from && cq.from.id) || '');
      if (fromChatId !== this.chatId) {
        this.stats.blockedUnauthorized += 1;
        return { handled: false, unauthorized: true };
      }

      const data = String(cq.data || '');
      if (!data.startsWith('hitl:')) return { handled: false };
      const nonce = data.slice(5);
      const entry = this.pendingNonces.get(nonce);
      if (!entry || entry.expiresAt < nowMs) {
        this.pendingNonces.delete(nonce);
        await this.callApi('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: '⏰ Prompt button expired. Check deck.',
          show_alert: false
        }).catch(() => {});
        return { handled: true, expired: true };
      }

      this.pendingNonces.delete(nonce);
      this.stats.handledCallbacks += 1;
      this.stats.lastActivityAt = new Date(nowMs).toISOString();

      let execResult = { ok: false, error: 'No action handler bound' };
      if (this.onExecuteAction) {
        execResult = await this.onExecuteAction({
          seatId: entry.seatId,
          keyStroke: entry.keyStroke,
          actionId: entry.actionId,
          source: 'telegram'
        });
      }

      const replyText = execResult && execResult.ok
        ? `✅ Sent "${entry.label}" to ${entry.seatId}`
        : `❌ Failed: ${(execResult && execResult.error) || 'error'}`;

      await this.callApi('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: replyText.slice(0, 180)
      }).catch(() => {});

      if (cq.message && cq.message.message_id) {
        await this.callApi('editMessageText', {
          chat_id: this.chatId,
          message_id: cq.message.message_id,
          text: `${replyText}\n🧾 Logged in ActionAuditLog (${entry.actionId}).`
        }).catch(() => {});
      }

      return { handled: true, ok: Boolean(execResult && execResult.ok), entry };
    }

    // 2. Handle Slash Commands from Authorized Operator
    if (update.message && typeof update.message.text === 'string') {
      const fromChatId = String((update.message.chat && update.message.chat.id) || '');
      if (fromChatId !== this.chatId) {
        this.stats.blockedUnauthorized += 1;
        return { handled: false, unauthorized: true };
      }

      const text = update.message.text.trim();
      if (!text.startsWith('/')) return { handled: false };
      this.stats.handledCommands += 1;
      this.stats.lastActivityAt = new Date(nowMs).toISOString();

      const [cmdRaw, ...rest] = text.split(/\s+/);
      const cmd = cmdRaw.split('@')[0].toLowerCase();

      if (cmd === '/status' || cmd === '/budget') {
        const summary = this.getFleetSummary ? await this.getFleetSummary(cmd === '/budget' ? 'budget' : 'status') : 'No telemetry snapshot yet.';
        await this.sendText(summary, { parse_mode: 'Markdown' });
        return { handled: true, command: cmd };
      }

      if (cmd === '/stop') {
        const seatId = (rest[0] || '').trim();
        if (!seatId || !/^[a-zA-Z0-9._@-]+$/.test(seatId)) {
          await this.sendText('Usage: `/stop <seatId>`', { parse_mode: 'Markdown' });
          return { handled: true, command: cmd, invalid: true };
        }
        const execResult = this.onExecuteAction
          ? await this.onExecuteAction({ seatId, keyStroke: 'C-c', actionId: 'interrupt_execution', source: 'telegram' })
          : { ok: false, error: 'Unavailable' };
        await this.sendText(
          execResult && execResult.ok
            ? `🛑 Sent Ctrl+C to \`${seatId}\` (logged in ActionAuditLog).`
            : `❌ Failed to stop \`${seatId}\`: ${(execResult && execResult.error) || 'error'}`,
          { parse_mode: 'Markdown' }
        );
        return { handled: true, command: cmd, ok: Boolean(execResult && execResult.ok) };
      }

      if (cmd === '/arm_breaker' || cmd === '/pause_breaker') {
        const nextMode = cmd === '/arm_breaker' ? 'auto_stop' : 'alert_only';
        if (this.onBreakerModeToggle) this.onBreakerModeToggle(nextMode);
        await this.sendText(
          nextMode === 'auto_stop'
            ? '🛡️ Circuit-Breaker armed in *AUTO-STOP (Ctrl+C)* mode.'
            : '🔔 Circuit-Breaker switched to *ALERT ONLY* mode.',
          { parse_mode: 'Markdown' }
        );
        return { handled: true, command: cmd, mode: nextMode };
      }

      if (cmd === '/pause_auto') {
        if (!this.onPauseAutoConsent) {
          await this.sendText('⚠️ Auto-Consent kill-switch is not available.', { parse_mode: 'Markdown' });
          return { handled: true, command: cmd, ok: false };
        }
        const res = await this.onPauseAutoConsent();
        const canceledCount = Number(res?.canceledCount ?? res?.canceled ?? 0) || 0;
        await this.sendText(
          `⏸ *Auto-Consent PAUSED (Master Kill-Switch)*\n• Canceled pending approvals: *${canceledCount}*\n• All scopes halted immediately.`,
          { parse_mode: 'Markdown' }
        );
        return { handled: true, command: cmd, ok: true, canceledCount };
      }
    }

    return { handled: false };
  }

  async pollOnce() {
    if (!this.isConfigured()) return [];
    try {
      const updates = await this.callApi('getUpdates', {
        offset: this.lastUpdateId ? this.lastUpdateId + 1 : 0,
        timeout: 0,
        allowed_updates: ['message', 'callback_query']
      });
      this.stats.lastError = null;
      const list = Array.isArray(updates) ? updates : [];
      for (const u of list) {
        if (typeof u.update_id === 'number' && u.update_id >= this.lastUpdateId) {
          this.lastUpdateId = u.update_id;
        }
        await this.handleUpdate(u);
      }
      return list;
    } catch (err) {
      this.stats.lastError = err.message || 'poll failed';
      return [];
    }
  }

  startPolling(intervalMs = 3000) {
    if (!this.isConfigured() || this.polling) return;
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      await this.pollOnce();
      if (this.polling) {
        this.pollTimer = setTimeout(tick, intervalMs);
        if (this.pollTimer.unref) this.pollTimer.unref();
      }
    };
    this.pollTimer = setTimeout(tick, 500);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stopPolling() {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getStatus() {
    return {
      configured: this.isConfigured(),
      polling: this.polling,
      maskedToken: maskBotToken(this.botToken),
      chatId: this.chatId ? `${this.chatId.slice(0, 3)}…${this.chatId.slice(-2)}` : '',
      pendingPromptButtons: this.pendingNonces.size,
      stats: { ...this.stats }
    };
  }
}
