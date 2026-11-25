/** Guardrails views: native ESM, explicit state/helpers, no ambient browser APIs. */
import { DEFAULT_PLAYBOOK_CONFIG, PLAYBOOK_RULE_IDS, PLAYBOOK_RULES_META, sanitizePlaybookConfig } from '../domain/playbooks-model.js';
import { DEFAULT_EVALUATOR_CONFIG, EVAL_SLOT_PRESETS, EVAL_HARDWARE_PROFILES } from '../domain/evaluator-model.js';

export function readPlaybooksFormPayload(doc) {
  const chk = (id) => Boolean(doc.getElementById(id)?.checked);
  const num = (id, fb) => {
    const v = Number(doc.getElementById(id)?.value);
    return Number.isFinite(v) ? v : fb;
  };
  return {
    enabled: chk('pbMasterEnable'),
    mode: (doc.getElementById('pbModeSelect')?.value || 'dry_run') === 'armed' ? 'armed' : 'dry_run',
    maxActionsPerHour: num('pbMaxActionsPerHour', 6),
    rules: {
      auto_compact_idle_hot: {
        enabled: chk('pbRule_auto_compact_idle_hot'),
        thresholdPct: num('pbParam_auto_compact_idle_hot', 78),
        cooldownMin: num('pbCooldown_auto_compact_idle_hot', 15)
      },
      auto_wake_parked: {
        enabled: chk('pbRule_auto_wake_parked'),
        minIdleMin: num('pbParam_auto_wake_parked', 10),
        cooldownMin: num('pbCooldown_auto_wake_parked', 20)
      },
      auto_nudge_stalled_queue: {
        enabled: chk('pbRule_auto_nudge_stalled_queue'),
        minWaitMin: num('pbParam_auto_nudge_stalled_queue', 12),
        cooldownMin: num('pbCooldown_auto_nudge_stalled_queue', 25)
      },
      auto_notify_critical_sa: {
        enabled: chk('pbRule_auto_notify_critical_sa'),
        minHitlMin: num('pbParam_auto_notify_critical_sa', 3),
        cooldownMin: num('pbCooldown_auto_notify_critical_sa', 10),
        notifyTelegram: chk('pbNotifyTgCheck')
      }
    }
  };
}

export function readEvaluatorFormPayload(doc) {
  const val = (id) => (doc.getElementById(id)?.value || '').trim();
  const chk = (id) => Boolean(doc.getElementById(id)?.checked);
  return {
    privacyMode: val('evalPrivacySelect') || 'local_only',
    autoSystem1Hitl: chk('evalAutoS1Check'),
    autoEscalateS2: chk('evalAutoS2Check'),
    maxCallsPerHour: Number(val('evalMaxCallsInput')) || 60,
    maxDailyUsd: Number(val('evalMaxUsdInput')) || 2.0,
    system1: {
      enabled: val('evalS1Dialect') !== 'disabled',
      presetId: val('evalS1Preset'),
      dialect: val('evalS1Dialect'),
      baseUrl: val('evalS1BaseUrl'),
      model: val('evalS1Model'),
      apiKey: val('evalS1ApiKey')
    },
    system2: {
      enabled: val('evalS2Dialect') !== 'disabled',
      presetId: val('evalS2Preset'),
      dialect: val('evalS2Dialect'),
      baseUrl: val('evalS2BaseUrl'),
      model: val('evalS2Model'),
      thinkingLevel: val('evalS2Thinking') || 'medium',
      apiKey: val('evalS2ApiKey')
    }
  };
}

export function renderPlaybooksSettingsHtml({
  playbooks = {}, deckLang, td, escapeHtml, shortSeat,
  notifPerm = 'unsupported', desktopNotificationsOn = false, playbooksStatusMessage = '',
  rulesList = PLAYBOOK_RULE_IDS, metaMap = PLAYBOOK_RULES_META
}) {
  const en = deckLang === 'en';
  const cfg = sanitizePlaybookConfig(playbooks.config || {}, DEFAULT_PLAYBOOK_CONFIG);
  const pb = { actionsLastHour: 0, recentRuns: [], ...playbooks, config: cfg };

  const ruleCardsHtml = rulesList.map((ruleId) => {
    const meta = metaMap[ruleId] || { icon: '⚙️', kind: 'write', titleRu: ruleId, titleEn: ruleId, descRu: '', descEn: '', paramKey: 'thresholdPct', paramLabelRu: 'Порог', paramLabelEn: 'Threshold', min: 1, max: 100 };
    const r = (cfg.rules && cfg.rules[ruleId]) || { enabled: false, cooldownMin: 15 };
    const paramVal = r[meta.paramKey] !== undefined ? r[meta.paramKey] : meta.min;
    const kindBadge = meta.kind === 'notify'
      ? `<span class="pb-veto-chip" style="color:#7dd3fc; border-color:rgba(56,189,248,0.4); background:rgba(56,189,248,0.12);">READ-ONLY NOTIFY</span>`
      : `<span class="pb-veto-chip" style="color:#6ee7b7; border-color:rgba(0,255,157,0.4); background:rgba(0,255,157,0.1);">SAFE WRITE-BACK</span>`;
    return `
      <div class="pb-rule-card${r.enabled ? ' active' : ''}">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-family:var(--font-mono); font-size:11.5px; font-weight:800; color:#f8fafc;">
            <input type="checkbox" id="pbRule_${escapeHtml(ruleId)}"${r.enabled ? ' checked' : ''} />
            <span>${meta.icon} ${escapeHtml(en ? meta.titleEn : meta.titleRu)}</span>
          </label>
          ${kindBadge}
        </div>
        <div style="font-size:11.5px; color:#94a3b8; line-height:1.45;">${escapeHtml(en ? meta.descEn : meta.descRu)}</div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-family:var(--font-mono); font-size:10.5px; color:#cbd5e1;">
          <label style="display:inline-flex; align-items:center; gap:6px;">
            <span>${escapeHtml(en ? meta.paramLabelEn : meta.paramLabelRu)}:</span>
            <input id="pbParam_${escapeHtml(ruleId)}" type="number" min="${meta.min}" max="${meta.max}" value="${paramVal}" class="ctrl-input" style="width:66px; background:#020617; border:1px solid rgba(56,189,248,0.3); padding:3px 6px; border-radius:4px;" />
          </label>
          <label style="display:inline-flex; align-items:center; gap:6px;">
            <span>${escapeHtml(td('pb.cooldownLabel'))}:</span>
            <input id="pbCooldown_${escapeHtml(ruleId)}" type="number" min="1" max="180" value="${r.cooldownMin || 15}" class="ctrl-input" style="width:62px; background:#020617; border:1px solid rgba(56,189,248,0.3); padding:3px 6px; border-radius:4px;" />
          </label>
          ${ruleId === 'auto_notify_critical_sa' ? `
            <label style="display:inline-flex; align-items:center; gap:5px; cursor:pointer;">
              <input type="checkbox" id="pbNotifyTgCheck"${r.notifyTelegram !== false ? ' checked' : ''} />
              <span>✈️ Telegram</span>
            </label>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  const dry = pb.lastDryRun;
  const dryRunHtml = dry ? `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:12px;">
      <div style="background:rgba(0,255,157,0.06); border:1px solid rgba(0,255,157,0.28); border-radius:8px; padding:10px;">
        <div style="font-family:var(--font-mono); font-size:11px; font-weight:800; color:#6ee7b7; margin-bottom:6px;">
          ⚡ ${escapeHtml(td('pb.eligibleTitle'))} (${(dry.eligible || []).length})
        </div>
        ${(dry.eligible || []).length === 0
          ? `<div style="font-size:11px; color:#94a3b8;">${en ? 'No eligible actions right now — fleet is quiet.' : 'Нет кандидатов на запуск прямо сейчас — флот спокоен.'}</div>`
          : (dry.eligible || []).map(c => `
              <div class="pb-run-row" style="margin-bottom:5px; border-color:rgba(0,255,157,0.3);">
                <div>
                  <div style="color:#6ee7b7; font-weight:800;">${escapeHtml(c.ruleId)} → ${escapeHtml(shortSeat(c.seatId))}</div>
                  <div style="color:#cbd5e1; font-size:10px; margin-top:2px;">${escapeHtml(c.reason)}</div>
                </div>
                <span class="pb-veto-chip" style="color:#6ee7b7; border-color:rgba(0,255,157,0.4);">${escapeHtml(c.kind.toUpperCase())}</span>
              </div>
            `).join('')}
      </div>
      <div style="background:rgba(251,191,36,0.06); border:1px solid rgba(251,191,36,0.28); border-radius:8px; padding:10px;">
        <div style="font-family:var(--font-mono); font-size:11px; font-weight:800; color:#fde68a; margin-bottom:6px;">
          🛡️ ${escapeHtml(td('pb.vetoedTitle'))} (${(dry.vetoed || []).length})
        </div>
        ${(dry.vetoed || []).length === 0
          ? `<div style="font-size:11px; color:#94a3b8;">${en ? 'No vetoed seats in this dry-run.' : 'В этом прогоне вето не срабатывало.'}</div>`
          : (dry.vetoed || []).map(v => `
              <div class="pb-run-row" style="margin-bottom:5px; border-color:rgba(251,191,36,0.32);">
                <div>
                  <div style="color:#fde68a; font-weight:800;">${escapeHtml(v.ruleId)} • ${escapeHtml(shortSeat(v.seatId))}</div>
                  <div style="color:#cbd5e1; font-size:10px; margin-top:2px;">${escapeHtml(v.detail)}</div>
                </div>
                <span class="pb-veto-chip">${escapeHtml(v.vetoCode)}</span>
              </div>
            `).join('')}
      </div>
    </div>
  ` : '';

  const runsHtml = pb.recentRuns.length === 0
    ? `<div style="font-size:11px; color:#94a3b8; font-family:var(--font-mono); padding:8px; background:rgba(2,6,23,0.55); border:1px solid rgba(148,163,184,0.18); border-radius:6px;">${escapeHtml(td('pb.noRuns'))}</div>`
    : pb.recentRuns.slice(0, 8).map(r => {
        const stColor = r.status === 'executed' ? '#6ee7b7' : r.status === 'dry_run' ? '#7dd3fc' : r.status === 'vetoed' ? '#fde68a' : '#fda4af';
        const clockLabel = r.at ? new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        return `
          <div class="pb-run-row">
            <div>
              <div style="color:${stColor}; font-weight:800;">[${escapeHtml(r.status.toUpperCase())}] ${escapeHtml(r.ruleId)} → ${escapeHtml(shortSeat(r.seatId))}</div>
              <div style="color:#cbd5e1; font-size:10px; margin-top:2px;">${escapeHtml(r.reason)} • ${escapeHtml(r.detail || '')}</div>
            </div>
            <span style="color:#64748b; white-space:nowrap;">${escapeHtml(clockLabel)}</span>
          </div>
        `;
      }).join('');

  return `
    <div style="display:flex; flex-direction:column; gap:14px;">
      <div style="font-size:12px; color:#cbd5e1; line-height:1.5; background:rgba(15,23,42,0.7); border:1px solid rgba(56,189,248,0.25); border-radius:8px; padding:10px 12px;">
        ${escapeHtml(td('pb.subtitle'))}
      </div>

      <!-- MASTER BAR + DESKTOP NOTIFICATIONS -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); gap:12px;">
        <div style="background:rgba(15,23,42,0.72); border:1px solid rgba(56,189,248,0.25); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <label style="display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-family:var(--font-mono); font-size:12px; font-weight:800; color:#f8fafc;">
              <input type="checkbox" id="pbMasterEnable"${cfg.enabled ? ' checked' : ''} />
              <span>${escapeHtml(td('pb.masterEnable'))}</span>
            </label>
            <span style="font-family:var(--font-mono); font-size:11px; color:#7dd3fc;">
              ${en ? 'Quota' : 'Квота'}: <b>${pb.actionsLastHour} / ${cfg.maxActionsPerHour}/h</b>
            </span>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <select id="pbModeSelect" class="rig-select" style="flex:1; min-width:190px; padding:6px 8px;">
              <option value="dry_run"${cfg.mode === 'dry_run' ? ' selected' : ''}>${escapeHtml(td('pb.modeDryRun'))}</option>
              <option value="armed"${cfg.mode === 'armed' ? ' selected' : ''}>${escapeHtml(td('pb.modeArmed'))}</option>
            </select>
            <label style="display:inline-flex; align-items:center; gap:6px; font-family:var(--font-mono); font-size:11px; color:#94a3b8;">
              <span>${escapeHtml(td('pb.hourlyCap'))}:</span>
              <input id="pbMaxActionsPerHour" type="number" min="1" max="30" value="${cfg.maxActionsPerHour}" class="ctrl-input" style="width:56px; background:#020617; border:1px solid rgba(56,189,248,0.3); padding:5px 6px; border-radius:5px;" />
            </label>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" class="action-pill key-proceed" onclick="savePlaybooksConfig()">${escapeHtml(td('pb.saveBtn'))}</button>
            <button type="button" class="action-pill" style="border-color:#38bdf8; color:#7dd3fc;" onclick="runPlaybooksDryRun()">${escapeHtml(td('pb.dryRunBtn'))}</button>
            <button type="button" class="action-pill" style="border-color:#ff0055; color:#fda4af;" onclick="resetPlaybooksState('pause')">${escapeHtml(td('pb.pauseBtn'))}</button>
            <button type="button" class="action-pill" onclick="resetPlaybooksState('reset_cooldowns')">${escapeHtml(td('pb.resetCdBtn'))}</button>
          </div>
        </div>

        <div style="background:rgba(15,23,42,0.72); border:1px solid rgba(168,85,247,0.3); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:8px;">
          <div style="font-family:var(--font-mono); font-size:12px; font-weight:800; color:#e9d5ff;">${escapeHtml(td('pb.desktopNotifTitle'))}</div>
          <div style="font-size:11.5px; color:#94a3b8; line-height:1.45;">${escapeHtml(td('pb.desktopNotifDesc'))}</div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:auto;">
            <button type="button" id="btnToggleDesktopNotif" class="action-pill${desktopNotificationsOn ? ' key-proceed' : ''}" onclick="toggleDesktopNotifications()">
              ${escapeHtml(desktopNotificationsOn ? td('pb.desktopNotifOn') : td('pb.desktopNotifOff'))}
            </button>
            <button type="button" class="action-pill" onclick="sendTestDesktopNotification()">${escapeHtml(td('pb.desktopNotifTest'))}</button>
            <span style="font-family:var(--font-mono); font-size:10px; color:#94a3b8;">permission: <b>${escapeHtml(notifPerm)}</b></span>
          </div>
        </div>
      </div>

      ${playbooksStatusMessage ? `<div id="pbActionStatus" style="font-family:var(--font-mono); font-size:11.5px; color:#6ee7b7; padding:6px 10px; border-radius:6px; background:rgba(0,255,157,0.08); border:1px solid rgba(0,255,157,0.28);">${escapeHtml(playbooksStatusMessage)}</div>` : ''}

      <!-- 4 WHITELISTED RULES -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(380px, 1fr)); gap:10px;">
        ${ruleCardsHtml}
      </div>

      ${dryRunHtml}

      <!-- RECENT RUNS -->
      <div style="display:flex; flex-direction:column; gap:6px;">
        <div style="font-family:var(--font-mono); font-size:11px; font-weight:800; color:#7dd3fc;">📜 ${escapeHtml(td('pb.recentRunsTitle'))}</div>
        ${runsHtml}
      </div>
    </div>
  `;
}

export function renderAiEvaluatorSettingsHtml({
  evaluator = {}, deckLang, td, escapeHtml,
  slotPresets = EVAL_SLOT_PRESETS, profiles = EVAL_HARDWARE_PROFILES
}) {
  const raw = evaluator.config || {};
  const cfg = { ...DEFAULT_EVALUATOR_CONFIG, ...raw,
    system1: { ...DEFAULT_EVALUATOR_CONFIG.system1, ...raw.system1 },
    system2: { ...DEFAULT_EVALUATOR_CONFIG.system2, ...raw.system2 } };
  const stats = evaluator.stats || { callsLastHour: 0, estDailyUsd: 0 };
  const en = deckLang === 'en';
  const s1Presets = Object.values(slotPresets.system1 || {});
  const s2Presets = Object.values(slotPresets.system2 || {});
  const s1Models = evaluator.discoveredModels?.system1 || [];
  const s2Models = evaluator.discoveredModels?.system2 || [];

  return `
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div style="background:rgba(15,23,42,0.68); border:1px solid rgba(168,85,247,0.28); border-radius:9px; padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-family:var(--font-mono); font-size:11px; color:#cbd5e1; font-weight:700;">${escapeHtml(td('eval.profileLabel'))}</span>
          <span style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8;">${en ? 'Calls/1h' : 'Вызовы/1ч'}: <b style="color:#7dd3fc;">${stats.callsLastHour || 0}/${cfg.maxCallsPerHour}</b> • ${en ? 'Today' : 'Сегодня'}: <b style="color:#fde68a;">$${Number(stats.estDailyUsd || 0).toFixed(3)}/$${cfg.maxDailyUsd}</b></span>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${profiles.map(p => `
            <button type="button" class="action-pill" style="font-size:10.5px; padding:4px 9px;" data-profile="${escapeHtml(p.id)}" onclick="applyEvalHardwareProfile(this.getAttribute('data-profile'))">${escapeHtml(en ? p.labelEn : p.labelRu)}</button>
          `).join('')}
        </div>
        <div style="font-size:10.5px; color:#6ee7b7; font-family:var(--font-mono);">🛡️ ${escapeHtml(td('eval.advisoryNote'))}</div>
      </div>

      <div class="eval-slot-grid">
        <!-- SLOT 1: SYSTEM 1 -->
        <div class="eval-slot-card">
          <div style="font-family:var(--font-mono); font-size:11.5px; font-weight:800; color:#7dd3fc;">${escapeHtml(td('eval.slot1Title'))}</div>
          <div>
            <label class="eval-field-label">Preset (Nov 2026)</label>
            <select id="evalS1Preset" class="eval-field-input" onchange="applyEvalSlotPreset('system1', this.value)">
              ${s1Presets.map(p => `<option value="${escapeHtml(p.id)}" ${cfg.system1.presetId === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
            </select>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <div>
              <label class="eval-field-label">Dialect</label>
              <select id="evalS1Dialect" class="eval-field-input">
                <option value="systemone_http" ${cfg.system1.dialect === 'systemone_http' ? 'selected' : ''}>/v1/systemone (Jev/Laya/Von)</option>
                <option value="classifier_http" ${cfg.system1.dialect === 'classifier_http' ? 'selected' : ''}>Classifier HTTP (Infinity/TEI)</option>
                <option value="embed_router" ${cfg.system1.dialect === 'embed_router' ? 'selected' : ''}>Embed Router (/api/embed)</option>
                <option value="fast_enum_fallback" ${cfg.system1.dialect === 'fast_enum_fallback' ? 'selected' : ''}>Fast Enum Fallback</option>
                <option value="disabled" ${cfg.system1.dialect === 'disabled' ? 'selected' : ''}>Disabled</option>
              </select>
            </div>
            <div>
              <label class="eval-field-label">Model ID</label>
              <input id="evalS1Model" class="eval-field-input" value="${escapeHtml(cfg.system1.model || '')}" placeholder="laya-base / jev-latest / von" />
            </div>
          </div>
          <div>
            <label class="eval-field-label">Base URL</label>
            <input id="evalS1BaseUrl" class="eval-field-input" value="${escapeHtml(cfg.system1.baseUrl || '')}" placeholder="http://127.0.0.1:8000" />
          </div>
          <div style="display:flex; gap:8px; align-items:flex-end;">
            <div style="flex:1;">
              <label class="eval-field-label">API Key (${cfg.system1.hasApiKey ? escapeHtml(cfg.system1.maskedApiKey) : 'optional for local'})</label>
              <input id="evalS1ApiKey" type="password" class="eval-field-input" value="" placeholder="${cfg.system1.hasApiKey ? escapeHtml(cfg.system1.maskedApiKey) : 'optional'}" />
            </div>
            <button type="button" class="action-pill" style="padding:5px 9px; font-size:10.5px;" onclick="loadEvalSlotModels('system1')">${escapeHtml(td('eval.loadModelsBtn'))}</button>
          </div>
          ${s1Models.length > 0 ? `<div style="display:flex; gap:4px; flex-wrap:wrap;">${s1Models.slice(0, 10).map(m => `<button type="button" class="eval-model-chip" data-model="${escapeHtml(m.id)}" onclick="document.getElementById('evalS1Model').value=this.getAttribute('data-model')">${escapeHtml(m.id)}${m.sizeGb ? ` (${m.sizeGb}GB)` : ''}</button>`).join('')}</div>` : ''}
        </div>

        <!-- SLOT 2: SYSTEM 2 -->
        <div class="eval-slot-card is-s2">
          <div style="font-family:var(--font-mono); font-size:11.5px; font-weight:800; color:#e9d5ff;">${escapeHtml(td('eval.slot2Title'))}</div>
          <div>
            <label class="eval-field-label">Preset (Nov 2026)</label>
            <select id="evalS2Preset" class="eval-field-input" onchange="applyEvalSlotPreset('system2', this.value)">
              ${s2Presets.map(p => `<option value="${escapeHtml(p.id)}" ${cfg.system2.presetId === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
            </select>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <div>
              <label class="eval-field-label">Dialect</label>
              <select id="evalS2Dialect" class="eval-field-input">
                <option value="gemini_native" ${cfg.system2.dialect === 'gemini_native' ? 'selected' : ''}>Gemini 4 Native (thinkingLevel)</option>
                <option value="openai_compat" ${cfg.system2.dialect === 'openai_compat' ? 'selected' : ''}>OpenAI-Compat (GLM-5 / GPT-6 / Proxy)</option>
                <option value="ollama_native" ${cfg.system2.dialect === 'ollama_native' ? 'selected' : ''}>Ollama / MLX Local</option>
                <option value="anthropic_native" ${cfg.system2.dialect === 'anthropic_native' ? 'selected' : ''}>Anthropic Native (Claude 5.5)</option>
                <option value="disabled" ${cfg.system2.dialect === 'disabled' ? 'selected' : ''}>Disabled</option>
              </select>
            </div>
            <div>
              <label class="eval-field-label">Model ID</label>
              <input id="evalS2Model" class="eval-field-input" value="${escapeHtml(cfg.system2.model || '')}" placeholder="gemini-4-hydrogen / glm-5.3 / qwen3.8:27b" />
            </div>
          </div>
          <div style="display:grid; grid-template-columns:2fr 1fr; gap:8px;">
            <div>
              <label class="eval-field-label">Base URL</label>
              <input id="evalS2BaseUrl" class="eval-field-input" value="${escapeHtml(cfg.system2.baseUrl || '')}" placeholder="http://127.0.0.1:11434" />
            </div>
            <div>
              <label class="eval-field-label">Thinking</label>
              <select id="evalS2Thinking" class="eval-field-input">
                ${['none', 'low', 'medium', 'high', 'xhigh'].map(lv => `<option value="${lv}" ${(cfg.system2.thinkingLevel || 'medium') === lv ? 'selected' : ''}>${lv}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:flex-end;">
            <div style="flex:1;">
              <label class="eval-field-label">API Key (${cfg.system2.hasApiKey ? escapeHtml(cfg.system2.maskedApiKey) : 'optional for local'})</label>
              <input id="evalS2ApiKey" type="password" class="eval-field-input" value="" placeholder="${cfg.system2.hasApiKey ? escapeHtml(cfg.system2.maskedApiKey) : 'optional'}" />
            </div>
            <button type="button" class="action-pill" style="padding:5px 9px; font-size:10.5px;" onclick="loadEvalSlotModels('system2')">${escapeHtml(td('eval.loadModelsBtn'))}</button>
          </div>
          ${s2Models.length > 0 ? `<div style="display:flex; gap:4px; flex-wrap:wrap;">${s2Models.slice(0, 10).map(m => `<button type="button" class="eval-model-chip" data-model="${escapeHtml(m.id)}" onclick="document.getElementById('evalS2Model').value=this.getAttribute('data-model')">${escapeHtml(m.id)}${m.sizeGb ? ` (${m.sizeGb}GB)` : ''}</button>`).join('')}</div>` : ''}
        </div>
      </div>

      <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:10px; align-items:end; background:rgba(15,23,42,0.55); border:1px solid rgba(148,163,184,0.18); border-radius:9px; padding:10px 12px;">
        <div>
          <label class="eval-field-label">Privacy Boundary</label>
          <select id="evalPrivacySelect" class="eval-field-input">
            <option value="local_only" ${cfg.privacyMode === 'local_only' ? 'selected' : ''}>${escapeHtml(td('eval.privacyLocal'))}</option>
            <option value="configured_endpoints" ${cfg.privacyMode === 'configured_endpoints' ? 'selected' : ''}>${escapeHtml(td('eval.privacyConfigured'))}</option>
          </select>
        </div>
        <div>
          <label class="eval-field-label">Max Calls / 1h</label>
          <input id="evalMaxCallsInput" type="number" min="1" max="500" class="eval-field-input" value="${cfg.maxCallsPerHour}" />
        </div>
        <div>
          <label class="eval-field-label">Max USD / Day</label>
          <input id="evalMaxUsdInput" type="number" step="0.1" min="0.1" max="100" class="eval-field-input" value="${cfg.maxDailyUsd}" />
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:#cbd5e1;">
          <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="evalAutoS1Check" ${cfg.autoSystem1Hitl ? 'checked' : ''} /> ${escapeHtml(td('eval.autoS1Label'))}</label>
          <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer;"><input type="checkbox" id="evalAutoS2Check" ${cfg.autoEscalateS2 ? 'checked' : ''} /> ${escapeHtml(td('eval.autoS2Label'))}</label>
        </div>
        <button type="button" class="action-pill key-proceed" style="padding:6px 14px; font-weight:800;" onclick="saveEvaluatorConfig()">${escapeHtml(td('eval.saveBtn'))}</button>
      </div>
      <div id="evalConfigStatus" style="font-family:var(--font-mono); font-size:11px; color:#6ee7b7; min-height:15px;">${escapeHtml(evaluator.statusMessage || '')}</div>
    </div>
  `;
}

export function renderGuardrailsSettingsHtml({
  guardrails = {}, liveFleetUsage = {}, agents = [], lastScreenBySeat = {},
  getDemoTerminalCapture = () => '', parseInteractivePromptOptions = () => [],
  tgPreviewReplyMsg = '', deckLang, td, escapeHtml
}) {
  const source = guardrails.breaker || {};
  const cfg = { enabled: false, mode: 'alert_only', maxSessionUsd: 15,
    maxSeatUsd: 5, maxUsdPerHour: 8, maxQaRounds: 3, ...source.config };
  const br = { status: 'armed', recentTrips: [], ...source, config: cfg };
  const tg = guardrails.telegram || {};
  const en = deckLang === 'en';
  const liveUsd = liveFleetUsage.totalEstUsd || br.lastSessionUsd || 0;
  const pctBudget = Math.min(100, Math.round((liveUsd / Math.max(0.1, cfg.maxSessionUsd)) * 100));

  // Live phone preview for urgent seat (or dev-check in demo)
  const urgentAgent = agents.find(a => a.state === 'urgent') || agents.find(a => a.id.includes('dev-check')) || agents[0];
  const previewScreen = (urgentAgent && (lastScreenBySeat[urgentAgent.id] || getDemoTerminalCapture(urgentAgent.id))) || '';
  const previewOpts = parseInteractivePromptOptions(previewScreen);

  const phoneBtnsHtml = previewOpts.length >= 2
    ? previewOpts.slice(0, 3).map(o => {
        const icon = o.isCancel ? '❌' : o.isPrimary ? '✅' : '🔹';
        const actId = o.isCancel ? 'cancel_prompt' : 'answer_prompt_option';
        return `<button type="button" class="action-pill" style="width:100%; justify-content:flex-start; padding:6px 9px; font-size:11px; border-color:${o.isCancel ? 'rgba(255,0,85,0.45)' : o.isPrimary ? 'rgba(0,255,157,0.5)' : 'rgba(56,189,248,0.35)'};" data-seat="${escapeHtml(urgentAgent.id)}" data-key="${escapeHtml(o.keyStroke)}" data-label="${escapeHtml(o.badge + '. ' + o.shortLabel)}" onclick="triggerTelegramPreviewAction(this.getAttribute('data-seat'), this.getAttribute('data-key'), this.getAttribute('data-label'), '${actId}')">${icon} ${escapeHtml(o.badge)}. ${escapeHtml(o.shortLabel)}</button>`;
      }).join('')
    : `<div style="font-size:11px; color:#6ee7b7; padding:6px 0;">${escapeHtml(tgPreviewReplyMsg || (en ? '✅ No pending HITL prompts — all seats clear.' : '✅ Нет ожидающих HITL-промптов — все узлы в норме.'))}</div>`;

  const tripsHtml = br.recentTrips.length === 0
    ? `<div style="font-size:11.5px; color:#6ee7b7; font-family:var(--font-mono); padding:8px; background:rgba(0,255,157,0.06); border:1px solid rgba(0,255,157,0.2); border-radius:6px;">${td('guard.noTrips')}</div>`
    : br.recentTrips.slice(0, 4).map(t => `
        <div style="font-family:var(--font-mono); font-size:11px; padding:7px 9px; border-radius:6px; background:rgba(255,0,85,0.1); border:1px solid rgba(255,0,85,0.35); display:flex; flex-direction:column; gap:2px;">
          <div style="color:#fda4af; font-weight:800;">🛑 ${escapeHtml(t.title)}</div>
          <div style="color:#cbd5e1; font-size:10.5px;">${escapeHtml(t.detail)} • action: <b>${escapeHtml(t.actionTaken)}</b></div>
        </div>
      `).join('');

  return `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(380px, 1fr)); gap:16px;">
      <!-- LEFT: BUDGET & LOOP CIRCUIT-BREAKER -->
      <div style="background:rgba(15,23,42,0.65); border:1px solid rgba(56,189,248,0.22); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:12px;">
        <div style="font-family:var(--font-mono); font-size:12px; font-weight:800; color:#fde68a;">${td('guard.breakerTitle')}</div>

        <div style="background:rgba(2,6,23,0.7); border:1px solid rgba(148,163,184,0.18); border-radius:8px; padding:10px;">
          <div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:11.5px; margin-bottom:6px;">
            <span>${en ? 'Session Spend' : 'Расход сессии'}: <b style="color:#fde68a;">~$${liveUsd.toFixed(2)}</b> / $${cfg.maxSessionUsd.toFixed(2)}</span>
            <span style="color:#7dd3fc;">${en ? 'Burn' : 'Скорость'}: <b>$${(br.burnUsdPerHour || 0).toFixed(2)}/h</b></span>
          </div>
          <div style="height:6px; background:rgba(148,163,184,0.15); border-radius:999px; overflow:hidden;">
            <div style="width:${pctBudget}%; height:100%; background:${pctBudget >= 85 ? '#ff0055' : pctBudget >= 60 ? '#fbbf24' : '#00ff9d'};"></div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-family:var(--font-mono); font-size:11px;">
          <label style="display:flex; flex-direction:column; gap:4px; color:#94a3b8;">
            ${td('guard.maxSession')}
            <input id="guardMaxSession" type="number" step="0.5" min="0.5" value="${cfg.maxSessionUsd}" class="ctrl-input" style="background:#020617; border:1px solid rgba(56,189,248,0.28); padding:6px 8px; border-radius:5px;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:4px; color:#94a3b8;">
            ${td('guard.maxSeat')}
            <input id="guardMaxSeat" type="number" step="0.5" min="0.5" value="${cfg.maxSeatUsd}" class="ctrl-input" style="background:#020617; border:1px solid rgba(56,189,248,0.28); padding:6px 8px; border-radius:5px;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:4px; color:#94a3b8;">
            ${td('guard.maxBurn')}
            <input id="guardMaxBurn" type="number" step="0.5" min="0.5" value="${cfg.maxUsdPerHour}" class="ctrl-input" style="background:#020617; border:1px solid rgba(56,189,248,0.28); padding:6px 8px; border-radius:5px;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:4px; color:#94a3b8;">
            ${td('guard.maxQa')}
            <input id="guardMaxQa" type="number" step="1" min="2" max="15" value="${cfg.maxQaRounds}" class="ctrl-input" style="background:#020617; border:1px solid rgba(56,189,248,0.28); padding:6px 8px; border-radius:5px;" />
          </label>
        </div>

        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <select id="guardModeSelect" class="rig-select" style="flex:1; min-width:160px; padding:6px 8px;">
            <option value="alert_only"${cfg.mode === 'alert_only' ? ' selected' : ''}>${td('guard.modeAlert')}</option>
            <option value="auto_stop"${cfg.mode === 'auto_stop' ? ' selected' : ''}>${td('guard.modeStop')}</option>
          </select>
          <button class="action-pill key-proceed" onclick="saveGuardrailsConfig()">${td('guard.saveBtn')}</button>
          <button class="action-pill" style="border-color:#fbbf24; color:#fde68a;" onclick="simulateDemoBreakerTrip()">${td('guard.simTripBtn')}</button>
          ${br.status === 'tripped' ? `<button class="action-pill" style="border-color:#00ff9d; color:#6ee7b7;" onclick="resetGuardrailsBreaker()">${td('guard.resetBtn')}</button>` : ''}
        </div>
        <div id="guardActionStatus" style="font-family:var(--font-mono); font-size:11px; color:#6ee7b7; min-height:14px;"></div>

        <div style="display:flex; flex-direction:column; gap:6px;">${tripsHtml}</div>
      </div>

      <!-- RIGHT: TELEGRAM HITL BRIDGE + LIVE PHONE PREVIEW -->
      <div style="background:rgba(15,23,42,0.65); border:1px solid rgba(56,189,248,0.22); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span style="font-family:var(--font-mono); font-size:12px; font-weight:800; color:var(--cyan);">${td('guard.tgTitle')}</span>
          <span class="action-pill" style="font-size:10px; border-color:${tg.configured ? '#00ff9d' : '#64748b'}; color:${tg.configured ? '#6ee7b7' : '#94a3b8'};">
            ${tg.configured ? `🟢 ONLINE (${escapeHtml(tg.chatId)})` : '⚪ STANDBY'}
          </span>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-family:var(--font-mono); font-size:11px;">
          <label style="display:flex; flex-direction:column; gap:4px; color:#94a3b8;">
            ${td('guard.tgToken')}
            <input id="tgBotTokenInput" type="password" placeholder="${escapeHtml(tg.maskedToken || '123456:AAH...')}" class="ctrl-input" style="background:#020617; border:1px solid rgba(56,189,248,0.28); padding:6px 8px; border-radius:5px;" />
          </label>
          <label style="display:flex; flex-direction:column; gap:4px; color:#94a3b8;">
            ${td('guard.tgChat')}
            <input id="tgChatIdInput" type="text" placeholder="${escapeHtml(tg.chatId || 'e.g. 123456789')}" class="ctrl-input" style="background:#020617; border:1px solid rgba(56,189,248,0.28); padding:6px 8px; border-radius:5px;" />
          </label>
        </div>

        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="action-pill key-proceed" onclick="handleTelegramAction('connect')">${td('guard.tgConnect')}</button>
          <button class="action-pill" onclick="handleTelegramAction('test')">${td('guard.tgTest')}</button>
          ${tg.configured ? `<button class="action-pill key-cancel" onclick="handleTelegramAction('disconnect')">${td('guard.tgDisconnect')}</button>` : ''}
        </div>
        <div style="font-family:var(--font-mono); font-size:10.5px; color:#94a3b8;">${td('guard.tgCommands')}</div>
        <div id="tgActionStatus" style="font-family:var(--font-mono); font-size:11px; color:#7dd3fc; min-height:14px;"></div>

        <!-- Interactive Telegram Phone Preview -->
        <div style="background:#0b1420; border:1px solid rgba(56,189,248,0.3); border-radius:12px; padding:10px 12px; display:flex; flex-direction:column; gap:7px;">
          <div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:10px; color:#7dd3fc; font-weight:800;">
            <span>🤖 @RigCommanderBot</span>
            <span style="color:#64748b;">${td('guard.tgPreviewTitle')}</span>
          </div>
          <div style="background:#142236; border-radius:8px; padding:8px 10px; font-family:var(--font-mono); font-size:11px; color:#e2e8f0; line-height:1.4;">
            <div style="color:#fda4af; font-weight:800; margin-bottom:4px;">🚨 RigCommander HITL — ${escapeHtml(urgentAgent ? urgentAgent.shortName : 'dev-check')}</div>
            <div style="color:#94a3b8; font-size:10.5px;">Allow negative control fault injection &amp; git checkout?</div>
            ${tgPreviewReplyMsg ? `<div style="margin-top:6px; color:#6ee7b7; border-top:1px dashed rgba(148,163,184,0.2); padding-top:5px;">${escapeHtml(tgPreviewReplyMsg)}</div>` : ''}
          </div>
          <div id="tgPreviewInlineBtns" style="display:flex; flex-direction:column; gap:5px;">
            ${phoneBtnsHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Pure view result; the caller owns DOM writes and all action handlers.
export function renderGuardrailsModal(deps) {
  const { activeGuardrailsTab, evaluator = {}, playbooks = {}, guardrails = {} } = deps;
  if (activeGuardrailsTab === 'evaluator') {
    return { html: renderAiEvaluatorSettingsHtml(deps), badge: {
      text: (evaluator.config?.privacyMode || DEFAULT_EVALUATOR_CONFIG.privacyMode) === 'local_only' ? 'LOCAL ONLY' : 'REDACTED HTTPS',
      borderColor: '#a855f7', color: '#e9d5ff'
    } };
  }
  if (activeGuardrailsTab === 'playbooks') {
    const { status = 'disabled', actionsLastHour = 0, config = {} } = playbooks;
    const quota = `${actionsLastHour}/${config?.maxActionsPerHour ?? DEFAULT_PLAYBOOK_CONFIG.maxActionsPerHour}/h`;
    return { html: renderPlaybooksSettingsHtml(deps), badge: {
      text: status === 'armed' ? `ARMED • ${quota}` : status === 'capped' ? `RATE-CAPPED • ${quota}` : status === 'dry_run' ? 'DRY-RUN PREVIEW' : 'DISABLED (SAFE)',
      borderColor: status === 'armed' ? '#00ff9d' : status === 'capped' ? '#ff0055' : '#38bdf8',
      color: status === 'armed' ? '#6ee7b7' : status === 'capped' ? '#fda4af' : '#7dd3fc'
    } };
  }
  const br = guardrails.breaker || {};
  return { html: renderGuardrailsSettingsHtml(deps), badge: {
    text: `${(br.status || 'armed').toUpperCase()} • ${br.config?.mode === 'auto_stop' ? 'AUTO-STOP' : 'ALERT ONLY'}`,
    borderColor: br.status === 'tripped' ? '#ff0055' : '#00ff9d',
    color: br.status === 'tripped' ? '#fda4af' : '#6ee7b7'
  } };
}
