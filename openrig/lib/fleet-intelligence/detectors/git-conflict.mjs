/**
 * GitConflictDetector (Fleet Intelligence Detector #7)
 *
 * Surfaces actionable code-level workspace hazards without spamming clean seats:
 *  - P0: Active unmerged conflict markers (`UU` / `AA`) in a git index.
 *  - P1: Cross-worktree / cross-clone file edit overlap (2+ workspaces of the same repo editing the same file).
 *  - P2: Concurrent active writers (`working`) sharing one unisolated git checkout.
 *  - P2: Stale branch drift (`behind >= 20` commits) with uncommitted local edits.
 */

import { GIT_STALE_BEHIND_FINDING } from '../../../assets/domain/git-radar.js';

function shortSeat(seatId) {
  return String(seatId || '').split('@')[0] || String(seatId || '');
}

export class GitConflictDetector {
  constructor() {
    this.id = 'git.worktree_conflict';
    this.name = 'Git Worktree & Conflict Radar';
  }

  evaluate(context) {
    const radar = context && context.gitRadar;
    if (!radar || !Array.isArray(radar.workspaces) || radar.workspaces.length === 0) {
      return [];
    }

    const findings = [];

    // 1. P0: Active merge conflict markers in index (unmergedCount > 0)
    for (const u of radar.unmergedWorkspaces || []) {
      const seats = Array.isArray(u.seatIds) ? u.seatIds : [];
      const primarySeat = seats[0] || '';
      findings.push({
        id: `git-unmerged-${u.workspaceId}`,
        detectorId: this.id,
        category: 'quality',
        severity: 'p0_urgent',
        confidence: 0.99,
        shortTitle: `${u.dirName}: merge-конфликт (${u.unmergedCount})`,
        title: `⚔️ Неразрешённый git merge-конфликт в ${u.dirName} (${u.unmergedCount} файл.)`,
        summary: `В индексе worktree ${u.dirName} (${u.branch || 'HEAD'}) есть незавершённые конфликты слияния. Агенты не смогут безопасно коммитить до их разрешения.`,
        remediation: `Откройте diff в карточке узла или разрешите конфликты в ${u.dirName} через git status / git merge --abort.`,
        metrics: {
          riskScore: 95,
          unmergedCount: u.unmergedCount,
          affectedSeats: seats,
          workspaceId: u.workspaceId,
          roiEstimate: 'Блокирует сборку и коммит'
        },
        actionPlan: primarySeat
          ? {
              kind: 'open_git_diff',
              seatTarget: primarySeat,
              workspaceId: u.workspaceId,
              commandPreview: `git status --short`
            }
          : null
      });
    }

    // 2. P1: Cross-worktree / cross-clone overlapping file edits (grouped by repoKey)
    const conflictsByRepo = new Map();
    for (const c of radar.conflicts || []) {
      if (!conflictsByRepo.has(c.repoKey)) {
        conflictsByRepo.set(c.repoKey, {
          repoKey: c.repoKey,
          repoLabel: c.repoLabel,
          files: [],
          highCount: 0,
          seatSet: new Set(),
          dirSet: new Set()
        });
      }
      const g = conflictsByRepo.get(c.repoKey);
      g.files.push(c.filePath);
      if (c.severity === 'high') g.highCount++;
      for (const w of c.workspaces || []) {
        g.dirSet.add(w.dirName);
        for (const sid of w.seatIds || []) g.seatSet.add(sid);
      }
    }

    for (const g of conflictsByRepo.values()) {
      const seats = Array.from(g.seatSet);
      const dirs = Array.from(g.dirSet);
      const sampleFiles = g.files.slice(0, 3).join(', ');
      const extraTxt = g.files.length > 3 ? ` +${g.files.length - 3}` : '';
      const primarySeat = seats[0] || '';
      findings.push({
        id: `git-overlap-${g.repoLabel}`,
        detectorId: this.id,
        category: 'quality',
        severity: g.highCount > 0 ? 'p1_high' : 'p2_medium',
        confidence: 0.94,
        shortTitle: `${g.repoLabel}: конфликт (${g.files.length})`,
        title: `⚔️ Пересечение правок в ${g.repoLabel}: ${g.files.length} файл(ов) между ${dirs.join(' ⇄ ')}`,
        summary: `Параллельные worktree редактируют одни и те же файлы (${sampleFiles}${extraTxt}). Затронутые сиденья: ${seats.map(shortSeat).join(', ')}.`,
        remediation: `Сравните изменения через «📄 Diff» в инспекторе или синхронизируйте слайсы до merge, чтобы избежать потери правок.`,
        metrics: {
          riskScore: g.highCount > 0 ? 84 : 62,
          conflictFileCount: g.files.length,
          conflictFiles: g.files.slice(0, 10),
          affectedSeats: seats,
          affectedWorkspaces: dirs,
          roiEstimate: 'Предотвращает merge-конфликт'
        },
        actionPlan: primarySeat
          ? {
              kind: 'open_git_diff',
              seatTarget: primarySeat,
              file: g.files[0] || '',
              commandPreview: `git diff -- ${g.files[0] || ''}`
            }
          : null
      });
    }

    // 3. P2: Concurrent active writers sharing the exact same unisolated checkout
    for (const h of radar.sharedWriteHazards || []) {
      const names = (h.activeSeatIds || []).map(shortSeat).join(' + ');
      findings.push({
        id: `git-shared-cwd-${h.workspaceId}`,
        detectorId: this.id,
        category: 'topology',
        severity: 'p2_medium',
        confidence: 0.88,
        shortTitle: `${h.dirName}: 2+ активных в 1 CWD`,
        title: `⚠️ Параллельная запись в общий checkout ${h.dirName} (${names})`,
        summary: `${h.activeSeatIds.length} активных агента работают одновременно в одной рабочей копии без изоляции worktree (${h.dirtyCount} изменённых файлов).`,
        remediation: `Разведите кодеров по отдельным git worktree или поставьте второго агента в очередь до завершения текущего слайса.`,
        metrics: {
          riskScore: 68,
          affectedSeats: h.activeSeatIds,
          dirtyCount: h.dirtyCount,
          workspaceId: h.workspaceId,
          roiEstimate: 'Исключает перезапись файлов'
        },
        actionPlan: h.activeSeatIds[0]
          ? {
              kind: 'open_git_diff',
              seatTarget: h.activeSeatIds[0],
              workspaceId: h.workspaceId
            }
          : null
      });
    }

    // 4. P2: Stale branch drift (`behind >= 20`) while carrying uncommitted edits
    for (const s of radar.staleWorkspaces || []) {
      if (s.behind < GIT_STALE_BEHIND_FINDING || s.dirtyCount <= 0) continue;
      const primarySeat = (s.seatIds || [])[0] || '';
      findings.push({
        id: `git-behind-${s.workspaceId}`,
        detectorId: this.id,
        category: 'quality',
        severity: 'p2_medium',
        confidence: 0.85,
        shortTitle: `${s.dirName}: отстаёт на -${s.behind}`,
        title: `📉 Устаревшая база в ${s.dirName}: −${s.behind} коммитов от upstream (${s.dirtyCount} прав.)`,
        summary: `Ветка ${s.branch || 'HEAD'} отстаёт на ${s.behind} коммитов при наличии ${s.dirtyCount} незакоммиченных изменений — риск тяжёлого rebase.`,
        remediation: `После завершения текущего слайса выполните rebase/sync ветки перед открытием следующей задачи.`,
        metrics: {
          riskScore: 55,
          behind: s.behind,
          ahead: s.ahead,
          dirtyCount: s.dirtyCount,
          affectedSeats: s.seatIds || [],
          workspaceId: s.workspaceId
        },
        actionPlan: primarySeat
          ? {
              kind: 'open_git_diff',
              seatTarget: primarySeat,
              workspaceId: s.workspaceId,
              commandPreview: 'git status -sb'
            }
          : null
      });
    }

    return findings;
  }
}
