import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SWARM_PROVIDER_KINDS,
  SWARM_READONLY_CAPABILITIES,
  deriveSwarmRigSlug,
  normalizeSwarmCluster,
  parseBoardMentions,
  buildSwarmGanttItems
} from '../openrig/assets/domain/swarm-model.js';
import { normalizeGanttSpans, buildHandoffSequenceModel } from '../openrig/assets/domain/gantt-model.js';
import {
  discoverSwarmFleets,
  clearSwarmDiscoveryCache
} from '../openrig/lib/swarm-discovery.mjs';
import { collectFleetGitRadar } from '../openrig/lib/git-radar.mjs';
import { AutoConsentEngine, VETO_NON_TMUX_SEAT } from '../openrig/lib/auto-consent-engine.mjs';

const FOREIGN_USER_DIR = ['', 'Users', 'bob-dev', 'private-repo'].join('/');
const FOREIGN_LINUX_DIR = ['', 'home', 'carol', '.ssh', 'id_ed25519'].join('/');
const FAKE_OPENAI_KEY = 'sk-proj-' + 'AbCdEfGhIjKlMnOpQrStUvWx123456';
const FAKE_GH_PAT = 'ghp_' + '1234567890abcdefghijklmnop';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

const SAFE_NPM_TEST_PROMPT = [
  'Requesting permission for: run_command',
  '$ npm test',
  'Run this command?',
  '› 1. Yes, allow once (y)',
  '  2. Always allow in this workspace',
  '  3. No, cancel (esc)',
  '↑/↓ Navigate · Enter to confirm'
].join('\n');

test('swarm-model derives deterministic rig slugs, projects statuses, parses @mentions, and builds Gantt spans', () => {
  assert.equal(deriveSwarmRigSlug('My Title', '4b4b30d8-9fd7-45fb-aad2-4deafb21fb96'), 'swarm-4b4b30d8');
  assert.equal(deriveSwarmRigSlug('Auth Refactor Team'), 'swarm-auth-refactor-team');
  assert.equal(deriveSwarmRigSlug('swarm-alpha'), 'swarm-alpha');

  const nowMs = Date.parse('2026-11-27T12:00:00Z');
  const cluster = normalizeSwarmCluster({
    providerKind: SWARM_PROVIDER_KINDS.ANTIGRAVITY,
    swarmId: '4b4b30d8-9fd7-45fb-aad2-4deafb21fb96',
    createdAt: '2026-11-27T11:30:00Z',
    members: {
      title: 'Auth Migration Swarm',
      members: {
        coordinator: {
          role: 'coordinator',
          phase: 'RUNNING',
          desired_state: 'RUNNING',
          wake_mode: 'working',
          last_read_seq: 4,
          wait_since: 2,
          model: 'gemini-4-neon-xhigh'
        },
        coder: {
          role: 'worker',
          phase: 'RUNNING',
          desired_state: 'RUNNING',
          wake_mode: 'working',
          workspace_mode: 'share',
          last_read_seq: 4,
          model: 'gemini-4-hydrogen-xhigh'
        },
        verifier: {
          role: 'worker',
          phase: 'RUNNING',
          desired_state: 'RUNNING',
          wake_mode: 'mentions',
          last_read_seq: 3,
          wait_since: 3,
          model: 'gemini-4-neon-medium'
        },
        stalled_worker: {
          role: 'worker',
          phase: 'RUNNING',
          desired_state: 'RUNNING',
          wake_mode: 'working',
          lastActivityAt: '2026-11-27T10:00:00Z',
          model: 'gemini-4-neon-medium'
        },
        dead_worker: {
          role: 'worker',
          phase: 'KILLED',
          desired_state: 'KILLED',
          wake_mode: 'working',
          killed: true,
          model: 'gemini-4-neon-medium'
        }
      }
    },
    plan: {
      goal: { title: 'Auth Migration', line: 'Ship JWT rotation' },
      tasks: {
        coder: 'IN PROGRESS: Implement JWT rotation',
        verifier: 'Waiting for coder handoff'
      },
      threads: [
        { id: 't-auth', title: 'JWT Rotation', tasks: ['coder', 'verifier'] }
      ]
    },
    boardEntries: [
      { seq: 1, agent: 'coordinator', text: '@coder Implement JWT rotation; email ops@example.com should not match', time: '2026-11-27T11:35:00Z', kind: 'brief' },
      { seq: 2, agent: 'coder', text: '@verifier Ready for verification', time: '2026-11-27T11:57:00Z' },
      { seq: 3, agent: 'verifier', text: '@coordinator [done] Verified 12/12 tests', time: '2026-11-27T11:58:00Z' },
      { seq: 4, agent: 'coordinator', text: '@all Final checkpoint', time: '2026-11-27T11:59:00Z' }
    ]
  }, { includeKilled: false, nowMs });

  assert.equal(cluster.rig.rigId, 'swarm-4b4b30d8');
  assert.equal(cluster.rig.providerKind, 'antigravity-swarm');
  assert.equal(cluster.nodes.length, 4, 'killed member must be filtered out by default');

  const byName = Object.fromEntries(cluster.nodes.map(n => [n.canonicalSessionName, n]));
  assert.equal(byName['coordinator@swarm-4b4b30d8'].activityState.display, 'working');
  assert.equal(byName['coder@swarm-4b4b30d8'].activityState.display, 'working');
  assert.equal(byName['verifier@swarm-4b4b30d8'].activityState.display, 'idle');
  assert.equal(byName['stalled_worker@swarm-4b4b30d8'].activityState.display, 'parked');
  assert.equal(byName['stalled_worker@swarm-4b4b30d8'].parkedData.parked, true);

  for (const node of cluster.nodes) {
    assert.deepEqual(node.capabilities, SWARM_READONLY_CAPABILITIES);
    assert.equal(node.capabilities.canSendKeys, false);
    assert.equal(node.capabilities.canCaptureTmux, false);
    assert.equal(node.capabilities.readOnlyBoard, true);
    assert.equal(node.swarmMeta.providerKind, 'antigravity-swarm');
    assert.equal(node.swarmMeta.title, 'Auth Migration Swarm');
    assert.equal(node.swarmMeta.goalTitle, 'Auth Migration');
    assert.equal(node.swarmMeta.goalLine, 'Ship JWT rotation');
    assert.ok(Array.isArray(node.swarmMeta.boardTail));
  }
  assert.equal(byName['coder@swarm-4b4b30d8'].swarmMeta.workspaceMode, 'share');
  assert.equal(byName['verifier@swarm-4b4b30d8'].swarmMeta.boardCursor, 3);
  assert.equal(byName['verifier@swarm-4b4b30d8'].swarmMeta.waitSince, 3);

  // Check edges & @mention parsing (no self-edges, no ops@example.com false edge)
  assert.ok(cluster.edges.some(e => e.from === 'coordinator@swarm-4b4b30d8' && e.to === 'coder@swarm-4b4b30d8'));
  assert.ok(cluster.edges.some(e => e.from === 'coder@swarm-4b4b30d8' && e.to === 'verifier@swarm-4b4b30d8' && e.liveActive === true));
  assert.ok(!cluster.edges.some(e => e.to.includes('example.com')));

  // Verify includeKilled: true keeps dead_worker
  const withKilled = normalizeSwarmCluster({
    providerKind: SWARM_PROVIDER_KINDS.ANTIGRAVITY,
    swarmId: '4b4b30d8-9fd7-45fb-aad2-4deafb21fb96',
    members: {
      members: {
        coder: { phase: 'RUNNING', wake_mode: 'working' },
        dead_worker: { phase: 'KILLED', wake_mode: 'working', killed: true }
      }
    }
  }, { includeKilled: true, nowMs });
  assert.equal(withKilled.nodes.length, 2);
  assert.equal(withKilled.nodes.find(n => n.canonicalSessionName.startsWith('dead_worker@')).killed, true);

  // Check Gantt & Handoff integration with gantt-model.js
  const gantt = buildSwarmGanttItems(
    {
      goal: { title: 'Auth Migration' },
      tasks: { coder: 'Implement JWT', verifier: 'Verify JWT' },
      threads: [{ id: 't-auth', title: 'JWT Rotation', tasks: ['coder', 'verifier'] }]
    },
    [
      { seq: 1, agent: 'coordinator', text: '@coder Start JWT', time: '2026-11-27 11:40:00' },
      { seq: 2, agent: 'coder', text: '@verifier Check JWT', time: '2026-11-27 11:50:00' },
      { seq: 3, agent: 'verifier', text: '@coordinator [done] Passed', time: '2026-11-27 11:55:00' }
    ],
    { rigId: 'swarm-4b4b30d8', nowMs: Date.parse('2026-11-27T12:05:00') }
  );
  assert.ok(gantt.length >= 3);
  const normalized = normalizeGanttSpans(gantt, {
    nowMs: Date.parse('2026-11-27T12:05:00'),
    rigFilter: 'swarm-4b4b30d8'
  });
  assert.ok(normalized.spans.length >= 3);
  const seqModel = buildHandoffSequenceModel(normalized.allWindowSpans);
  assert.ok(seqModel.steps.length >= 2);

  // Verify standalone parseBoardMentions handles JSONL string directly
  const parsedStr = parseBoardMentions(
    JSON.stringify({ seq: 1, agent: 'a', text: '@b hello' }) + '\n{broken-line\n',
    { rigId: 'swarm-test', activeMemberNames: ['a', 'b'], nowMs }
  );
  assert.equal(parsedStr.edges.length, 1);
  assert.equal(parsedStr.callsBySeat['a@swarm-test'].out, 1);
  assert.equal(parsedStr.callsBySeat['b@swarm-test'].in, 1);
});

test('discoverSwarmFleets discovers all 3 vendors (Antigravity, Claude Teams, Codex Subagents), isolates raw gitWorktrees, and redacts homedir/secrets', async () => {
  clearSwarmDiscoveryCache();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rigcmd-swarm-'));
  const fakeHome = path.join(root, 'fake-home');
  const brainRoot = path.join(fakeHome, '.gemini', 'antigravity-cli', 'brain');
  const claudeTeamsRoot = path.join(fakeHome, '.claude', 'teams');
  const claudeTasksRoot = path.join(fakeHome, '.claude', 'tasks');
  const codexSessionsRoot = path.join(fakeHome, '.codex', 'sessions');

  // 1. Antigravity /swarm fixture (with >32KB board tail, comma-separated worktrees, secrets & foreign paths)
  const agySwarmId = '9a1b2c3d-1111-2222-3333-444455556666';
  const agySwarmDir = path.join(brainRoot, agySwarmId, '.system_generated', 'swarm');
  const agyCoderConv = '11111111-aaaa-bbbb-cccc-000000000001';
  const agyCoderTrDir = path.join(brainRoot, agyCoderConv, '.system_generated', 'logs');
  const agyWorktreeA = path.join(fakeHome, 'worktrees', 'repo-a');
  const agyWorktreeB = path.join(fakeHome, 'worktrees', 'repo-b');

  await fs.mkdir(agySwarmDir, { recursive: true });
  await fs.mkdir(agyCoderTrDir, { recursive: true });
  await fs.mkdir(agyWorktreeA, { recursive: true });
  await fs.mkdir(agyWorktreeB, { recursive: true });

  await fs.writeFile(path.join(agySwarmDir, 'swarm.json'), JSON.stringify({
    version: 1,
    backend: 'local',
    swarm_id: agySwarmId,
    created_at: '2026-11-27T11:00:00Z'
  }));
  await fs.writeFile(path.join(agySwarmDir, 'members.json'), JSON.stringify({
    title: `Refactor ${FOREIGN_USER_DIR} with ${FAKE_OPENAI_KEY}`,
    members: {
      coordinator: {
        conversation_id: agySwarmId,
        role: 'coordinator',
        phase: 'RUNNING',
        desired_state: 'RUNNING',
        wake_mode: 'working',
        last_read_seq: 20,
        wait_since: 18,
        model: 'gemini-4-neon-xhigh'
      },
      coder: {
        conversation_id: agyCoderConv,
        role: 'worker',
        phase: 'RUNNING',
        desired_state: 'RUNNING',
        wake_mode: 'working',
        workspace_mode: 'share',
        workspace: `${agyWorktreeA}, ${agyWorktreeB}`,
        last_read_seq: 20,
        model: 'gemini-4-hydrogen-xhigh'
      },
      killed_helper: {
        conversation_id: '22222222-aaaa-bbbb-cccc-000000000002',
        role: 'worker',
        phase: 'KILLED',
        desired_state: 'KILLED',
        wake_mode: 'working',
        killed: true,
        workspace: path.join(fakeHome, 'worktrees', 'killed-wt')
      }
    }
  }));
  await fs.writeFile(path.join(agySwarmDir, 'plan.json'), JSON.stringify({
    goal: { title: 'Security Cleanse', line: `Token=${FAKE_GH_PAT} at ${FOREIGN_LINUX_DIR}` },
    tasks: {
      coder: `IN PROGRESS: Fix ${agyWorktreeA} using Bearer ${FAKE_JWT}`
    },
    threads: [{ id: 'thr-1', title: 'Security Cleanse', tasks: ['coder'] }]
  }));

  // Write >35KB board.jsonl to verify tail-only <=32KB read drops partial first line cleanly
  const padding = 'x'.repeat(1800);
  const boardLines = [];
  for (let i = 1; i <= 20; i++) {
    boardLines.push(JSON.stringify({
      seq: i,
      agent: i % 2 === 1 ? 'coordinator' : 'coder',
      text: i === 20
        ? `@coordinator [done] Finished work in ${agyWorktreeA} (API_KEY=${FAKE_OPENAI_KEY})`
        : `@${i % 2 === 1 ? 'coder' : 'coordinator'} step ${i} ${padding}`,
      time: '2026-11-27T11:55:00Z',
      kind: i === 1 ? 'brief' : 'message'
    }));
  }
  await fs.writeFile(path.join(agySwarmDir, 'board.jsonl'), boardLines.join('\n') + '\n');
  await fs.writeFile(path.join(agyCoderTrDir, 'transcript.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-11-27T11:10:00Z', payload: { cwd: agyWorktreeA, model: 'gemini-4-hydrogen-xhigh' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-11-27T11:55:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 150_000 } } } })
  ].join('\n') + '\n');

  // 2. Claude Code Agent Teams fixture
  const claudeTeamDir = path.join(claudeTeamsRoot, 'payments-audit');
  const claudeTeamInboxDir = path.join(claudeTeamDir, 'inboxes');
  const claudeTeamTasksDir = path.join(claudeTasksRoot, 'payments-audit');
  const claudeWorktree = path.join(fakeHome, 'src', 'payments');
  await fs.mkdir(claudeTeamInboxDir, { recursive: true });
  await fs.mkdir(claudeTeamTasksDir, { recursive: true });
  await fs.mkdir(claudeWorktree, { recursive: true });

  await fs.writeFile(path.join(claudeTeamDir, 'config.json'), JSON.stringify({
    name: 'payments-audit',
    description: 'Audit payment webhook signatures',
    createdAt: Date.parse('2026-11-27T11:20:00Z'),
    leadAgentId: 'lead@payments-audit',
    members: [
      { agentId: 'lead@payments-audit', name: 'lead', agentType: 'team-lead', model: 'claude-opus-4', cwd: claudeWorktree, status: 'working' },
      { agentId: 'reviewer@payments-audit', name: 'reviewer', agentType: 'code-reviewer', model: 'claude-sonnet-4', worktree: claudeWorktree, status: 'idle' }
    ]
  }));
  await fs.writeFile(path.join(claudeTeamTasksDir, '1.json'), JSON.stringify({
    id: '1',
    subject: `Verify webhook secret ${FAKE_GH_PAT}`,
    status: 'in_progress',
    owner: 'lead',
    createdAt: '2026-11-27T11:22:00Z'
  }));
  await fs.writeFile(path.join(claudeTeamInboxDir, 'reviewer.json'), JSON.stringify([
    { from: 'lead', text: 'Please inspect webhook.ts', timestamp: '2026-11-27T11:45:00Z' }
  ]));

  // 3. Codex Subagents fixture
  const codexDayDir = path.join(codexSessionsRoot, '2026', '11', '27');
  const codexWorktree = path.join(fakeHome, '.codex', 'worktrees', 'sub-1');
  await fs.mkdir(codexDayDir, { recursive: true });
  await fs.mkdir(codexWorktree, { recursive: true });

  await fs.writeFile(path.join(codexDayDir, 'rollout-parent.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-11-27T11:30:00Z', payload: { id: 'codex-parent-001', cwd: claudeWorktree, model: 'gpt-5.3-codex' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-11-27T11:31:00Z', payload: { type: 'collab_agent_spawn_end', new_thread_id: 'codex-child-002' } })
  ].join('\n') + '\n');

  await fs.writeFile(path.join(codexDayDir, 'rollout-child.jsonl'), [
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-11-27T11:31:05Z',
      payload: {
        id: 'codex-child-002',
        cwd: codexWorktree,
        model: 'gpt-5.3-codex',
        source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-001', depth: 1, agent_nickname: 'parser', agent_role: 'worker' } } }
      }
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-11-27T11:58:00Z',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 54_400 } } }
    })
  ].join('\n') + '\n');

  const nowMs = Date.parse('2026-11-27T11:59:00Z');
  const res = await discoverSwarmFleets({
    brainRoot,
    claudeTeamsRoot,
    codexSessionsRoot,
    homeDir: fakeHome,
    nowMs,
    includeKilled: false
  });

  assert.equal(res.swarms.length, 3, 'all 3 multi-vendor swarms discovered');
  assert.equal(res.availableRigs.length, 3);
  const kinds = new Set(res.swarms.map(s => s.rig.providerKind));
  assert.deepEqual(kinds, new Set(['antigravity-swarm', 'claude-teams', 'codex-subagents']));

  // Killed worker filtered out by default; included on opt-in
  assert.ok(!res.nodes.some(n => n.canonicalSessionName.startsWith('killed_helper@')));
  const resWithKilled = await discoverSwarmFleets({
    brainRoot,
    claudeTeamsRoot,
    codexSessionsRoot,
    homeDir: fakeHome,
    nowMs,
    includeKilled: true
  });
  assert.ok(resWithKilled.nodes.some(n => n.canonicalSessionName.startsWith('killed_helper@')));

  // Every node must have honest non-tmux read-only capabilities
  for (const n of res.nodes) {
    assert.deepEqual(n.capabilities, { canSendKeys: false, canCaptureTmux: false, readOnlyBoard: true });
    assert.equal(n.tmuxAttachCommand, null);
  }

  // Raw gitWorktrees / worktreePaths exist separately for server-side collectFleetGitRadar
  assert.ok(res.worktreePaths.includes(agyWorktreeA));
  assert.ok(res.worktreePaths.includes(agyWorktreeB));
  assert.ok(res.worktreePaths.includes(claudeWorktree));
  assert.ok(res.worktreePaths.includes(codexWorktree));
  assert.ok(res.gitWorktrees.every(w => w.canonicalSessionName && path.isAbsolute(w.cwd)));

  // Verify collectFleetGitRadar consumes res.gitWorktrees cleanly without errors
  const mockExecGit = async (cwd, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ok: true, stdout: `${cwd}\n` };
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return { ok: true, stdout: '.git\n' };
    if (args[0] === 'config') return { ok: true, stdout: 'https://example.invalid/org/repo.git\n' };
    if (args[0] === 'status') return { ok: true, stdout: '# branch.head feat\n# branch.oid 1234567\n1 M. N... 100644 100644 100644 abc def src/shared.js\n' };
    if (args[0] === 'diff') return { ok: true, stdout: '4\t1\tsrc/shared.js\n' };
    return { ok: true, stdout: '' };
  };
  const radar = await collectFleetGitRadar(res.gitWorktrees, { execGitFn: mockExecGit });
  assert.ok(radar.workspaces.length >= 3);
  assert.ok(radar.conflicts.some(c => c.filePath === 'src/shared.js'));

  // STRICT REDACTION CHECK: ZERO personal OS paths or secrets anywhere in telemetry output!
  const telemetryJson = JSON.stringify({
    swarms: res.swarms,
    availableRigs: res.availableRigs,
    nodes: res.nodes,
    edges: res.edges,
    ganttItems: res.ganttItems
  });
  assert.equal(telemetryJson.includes(fakeHome), false, 'fakeHome must never leak into telemetry');
  assert.equal(telemetryJson.includes(FOREIGN_USER_DIR), false, 'foreign /Users path must be redacted');
  assert.equal(telemetryJson.includes('/Users/'), false, 'zero /Users/ strings allowed in telemetry');
  assert.equal(telemetryJson.includes('/home/'), false, 'zero /home/ strings allowed in telemetry');
  assert.equal(telemetryJson.includes(FAKE_OPENAI_KEY), false, 'API key must be redacted');
  assert.equal(telemetryJson.includes(FAKE_GH_PAT), false, 'GitHub PAT must be redacted');
  assert.equal(telemetryJson.includes(FAKE_JWT), false, 'JWT must be redacted');
  assert.ok(telemetryJson.includes('~/worktrees/repo-a'), 'homeDir must collapse cleanly to ~');

  // Verify Antigravity transcript bounded read populated contextUsage on coder
  const agyCoder = res.nodes.find(n => n.canonicalSessionName === 'coder@swarm-9a1b2c3d');
  assert.ok(agyCoder);
  assert.equal(agyCoder.contextUsage.usedTokens, 150_000);
  assert.equal(agyCoder.contextUsage.usedPercentage, 15);

  await fs.rm(root, { recursive: true, force: true });
});

test('AutoConsentEngine enforces hard VETO_NON_TMUX_SEAT on non-tmux swarm seats (0 capture, 0 writes)', async () => {
  let captures = 0;
  let dispatches = 0;

  const engine = new AutoConsentEngine({
    configPath: null,
    initialConfig: {
      enabled: true,
      mode: 'armed',
      graceWindowMs: 1500,
      projects: { 'swarm-4b4b30d8': { profile: 'trusted_dev' } }
    },
    captureSeatScreen: async () => {
      captures += 1;
      return SAFE_NPM_TEST_PROMPT;
    },
    dispatchOptionOne: async () => {
      dispatches += 1;
      return { ok: true };
    }
  });

  const swarmSeat = {
    canonicalSessionName: 'coder@swarm-4b4b30d8',
    rigId: 'swarm-4b4b30d8',
    capabilities: { canSendKeys: false, canCaptureTmux: false, readOnlyBoard: true }
  };

  const res = await engine.observeSeat({
    seat: swarmSeat,
    screenText: SAFE_NPM_TEST_PROMPT
  });
  assert.equal(res.action, 'escalated');
  assert.equal(res.reason, VETO_NON_TMUX_SEAT);
  assert.equal(res.vetoCode, VETO_NON_TMUX_SEAT);
  assert.equal(res.evaluation.vetoCode, VETO_NON_TMUX_SEAT);
  assert.equal(captures, 0);
  assert.equal(dispatches, 0);
  assert.equal(engine.getState().pendingApprovals.length, 0);
  assert.equal(engine.getState().recentRuns[0].vetoCode, VETO_NON_TMUX_SEAT);

  // Also reject session grant explicitly bound to a non-tmux seat
  const grantRes = await engine.createSessionGrant({
    scope: 'seat',
    targetId: 'coder@swarm-4b4b30d8',
    profile: 'trusted_dev',
    seatSessionEpoch: 'ep:1',
    seat: swarmSeat
  });
  assert.equal(grantRes.ok, false);
  assert.equal(grantRes.vetoCode, VETO_NON_TMUX_SEAT);

  // Also verify TOCTOU mid-grace veto if a seat turns non-tmux before dispatch
  let pendingTimerFn = null;
  const toctouEngine = new AutoConsentEngine({
    configPath: null,
    initialConfig: {
      enabled: true,
      mode: 'armed',
      graceWindowMs: 1500,
      projects: { 'core-platform': { profile: 'trusted_dev' } }
    },
    setTimeoutFn: (fn) => {
      pendingTimerFn = fn;
      return { id: 1, unref() {} };
    },
    clearTimeoutFn: () => {},
    captureSeatScreen: async () => SAFE_NPM_TEST_PROMPT,
    getLiveContext: async () => ({
      seat: {
        canonicalSessionName: 'dev-coder@core-platform',
        rigId: 'core-platform',
        capabilities: { canSendKeys: false, canCaptureTmux: false, readOnlyBoard: true }
      }
    }),
    dispatchOptionOne: async () => {
      dispatches += 1;
      return { ok: true };
    }
  });

  const armed = await toctouEngine.observeSeat({
    seat: { canonicalSessionName: 'dev-coder@core-platform', rigId: 'core-platform', capabilities: { canSendKeys: true } },
    screenText: SAFE_NPM_TEST_PROMPT
  });
  assert.equal(armed.action, 'pending');
  assert.ok(pendingTimerFn);
  await pendingTimerFn();
  await new Promise((r) => setImmediate(r));
  assert.equal(dispatches, 0, 'TOCTOU non-tmux seat transition must execute 0 dispatches');
  assert.equal(toctouEngine.getState().recentRuns[0].subVetoCode, VETO_NON_TMUX_SEAT);

  engine.dispose();
  toctouEngine.dispose();
});
