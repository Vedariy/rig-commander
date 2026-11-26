export {
  parseInteractivePromptOptions,
  detectLiveHitlPrompt,
  getLiveHitlOptions,
  extractHitlCommandPreview,
  extractDetectedTerminalModel,
  detectTerminalIdleAtPrompt,
  hasDirtyTerminalInputBox,
  classifyTerminalScreen
} from './prompt-parser.js';
export {
  THERMAL_CURVE_OPTIMAL_PCT,
  THERMAL_CURVE_BASE_H,
  THERMAL_CURVE_MAX_H,
  THERMAL_CURVE_EXP_K,
  evalThermalCurveHeightPct,
  buildThermalCurvePaths,
  buildThermalCurveSvgHtml,
  getContextThermal,
  formatTokensShort,
  computeBurn
} from './thermal.js';
export { getAgentAudioProfile } from './audio.js';
export {
  GANTT_LONG_WAIT_MS,
  GANTT_MODES,
  GANTT_GROUP_MODES,
  ganttChainColor,
  ganttRoleRank,
  isQaSeatId,
  isGanttItemNoise,
  formatGanttDuration,
  normalizeGanttSpans,
  packLaneIntervals,
  buildGanttLanes,
  buildHandoffSequenceModel
} from './gantt-model.js';
export { EDGE_STATUS_META, classifyEdgeQueueStatus } from './edge-state.js';
export {
  BUDGET_WINDOWS,
  DEFAULT_BILLING_PLANS,
  sanitizeBillingPlans,
  getUsageForWindow,
  getWindowAmortizedPlanUsd,
  projectMonthlyApiUsd,
  evaluatePoolBilling,
  computeFleetFinOpsReport
} from './finops.js';
export { buildShareCardModel, renderShareCardSvg } from './share-card.js';
export { encodeQrMatrix, renderQrSvg } from './qr.js';
export {
  PREFS_STORAGE_KEY,
  DEFAULT_DECK_PREFS,
  sanitizeDeckPrefs,
  loadDeckPrefs,
  saveDeckPrefs,
  resolveEffectiveRigFilter
} from './preferences.js';
export { DECK_I18N, resolveDeckLang, tDeck } from './i18n.js';
export {
  QUEST_STEPS,
  createQuestState,
  getQuestProgress,
  getNextQuestStep,
  completeQuestStep,
  resetQuestState,
  shouldAutoOpenQuest
} from './quest.js';
export {
  parseSemver,
  compareSemver,
  isNewerVersion,
  normalizeNpmReleaseInfo
} from './semver.js';
export {
  DEFAULT_ACTION_COOLDOWN_MS,
  DEFAULT_DESTRUCTIVE_COOLDOWN_MS,
  buildSeatScopeKey,
  buildSeatSendKey,
  buildEndpointScopeKey,
  createIdempotencyKey,
  ActionFlightGuard,
  ServerIdempotencyCache
} from './action-guard.js';
export {
  GRAPH_LAYOUT_MODES,
  isEdgeActiveForLayout,
  classifyNodeActivityTier,
  getRolePlacementInfo,
  estimateNodeBox,
  evaluateClusterReadability,
  classifyQuietRigClusters,
  computeAdaptiveEdgePath,
  computeTopologyLayout,
  computeAnchoredPopoverRect
} from './topology-layout.js';
export {
  EVAL_TIERS,
  EVAL_RISK_LEVELS,
  EVAL_S1_DIALECTS,
  EVAL_S2_DIALECTS,
  ALLOWED_EVAL_ACTION_IDS,
  SYSTEM1_QUESTIONS,
  SYSTEM1_PROTOTYPE_ANCHORS,
  EVAL_SLOT_PRESETS,
  EVAL_HARDWARE_PROFILES,
  DEFAULT_EVALUATOR_CONFIG,
  isLoopbackEndpoint,
  sanitizeBaseUrl,
  sanitizeSlotBinding,
  sanitizeEvaluatorConfig,
  normalizedShannonEntropy,
  cosineSimilarity,
  scorePrototypeCentroids,
  evaluateS1EscalationGate,
  renderS1TemplateSummary,
  extractStructuredJson,
  validateAndNormalizeVerdict,
  buildSystem2Prompts,
  buildCascadeBreadcrumb
} from './evaluator-model.js';
export {
  extractItemContextMeta,
  extractContextArtifacts,
  buildSharedContextGraph,
  getContextDriftSignals,
  matchRelatedDecisions
} from './context-lineage.js';
export {
  GIT_STALE_BEHIND_WARN,
  GIT_STALE_BEHIND_FINDING,
  parseGitStatusPorcelainV2,
  parseGitNumstat,
  mergeGitNumstats,
  normalizeRepoKey,
  analyzeFleetGitRadar
} from './git-radar.js';
export {
  SHIFT_DIGEST_WINDOWS_H,
  CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_SPEND_DELTA_USD,
  CTX_WARN_THRESHOLD,
  CTX_CRIT_THRESHOLD,
  CTX_COMPACT_DROP_PCT,
  diffTelemetrySnapshots,
  buildShiftDigest,
  formatShiftDigestMarkdown
} from './shift-digest.js';
export {
  PALETTE_SCOPES,
  QUEUE_STALE_PENDING_MS,
  QUEUE_STUCK_IN_PROGRESS_MS,
  PALETTE_RECENT_MAX,
  PALETTE_GROUP_ORDER,
  parsePaletteQuery,
  fuzzyScore,
  rankPaletteItems,
  pushRecentPaletteId,
  triageQueueItems,
  buildPaletteIndex
} from './command-palette.js';
export {
  PLAYBOOK_RULE_IDS,
  PLAYBOOK_VETO_CODES,
  PLAYBOOK_RULES_META,
  DEFAULT_PLAYBOOK_CONFIG,
  sanitizePlaybookConfig,
  evaluatePlaybookCandidates,
  buildPlaybookFaviconDataUri
} from './playbooks-model.js';

export {
  OUTAGE_TIERS, STATE_BUNDLE_SCHEMA_VERSION,
  SAFE_RIG_NAME_RE, SAFE_SEAT_ID_RE, SAFE_ATTEMPT_ID_RE, SAFE_PROVIDER_ID_RE,
  validateResilienceTarget, parseSnapshotTable, detectSleepWakeJump,
  classifyFleetResilience, isStateBundleEnvelope, mergeHostManifestEnvelopes,
  buildResurrectPlanPreview, normalizeRestoreReceipt, buildDemoResilienceScenario
} from './resilience-model.js';

export {
  AUTO_CONSENT_SCHEMA_VERSION,
  AUTO_CONSENT_MODES,
  AUTO_CONSENT_PROFILES,
  AUTO_CONSENT_LIMITS,
  AUTO_CONSENT_VETO_CODES,
  DEFAULT_AUTO_CONSENT_FLAGS,
  DEFAULT_AUTO_CONSENT_CONFIG,
  DESTRUCTIVE_VETO_PATTERNS,
  PACKAGE_INSTALL_PATTERNS,
  EXTERNAL_NETWORK_PATTERNS,
  SHELL_METACHAR_RE,
  SAFE_READONLY_COMMAND_RE,
  hasForbiddenExecFlag,
  isSafeReadOnlyCommand,
  normalizeCommandText,
  computePromptFingerprint,
  classifyDestructiveVetoes,
  sanitizeAutoConsentFlags,
  sanitizeAutoConsentConfig,
  createSessionGrant,
  isSessionGrantValid,
  resolveEffectiveConsentPolicy,
  evaluateAutoConsentPrompt,
  summarizeActiveAutoConsentScopes
} from './auto-consent-model.js';


