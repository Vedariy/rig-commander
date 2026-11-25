/**
 * Adaptive & Fixed Topology Graph Layout Engine (Pure Domain Module).
 *
 * Supports two operator-selectable modes:
 *   - 'dynamic' (Active Stage + Compact Dormant Bench):
 *       Working, urgent, and actively communicating nodes are distributed evenly
 *       across the upper stage with pixel-aware collision & edge-badge clearance,
 *       while dormant/non-communicating nodes dock compactly at the bottom bench.
 *   - 'fixed' (Stable Role-Tiered Coordinates):
 *       Every node keeps a deterministic role-tiered seat invariant to idle/working
 *       state transitions, while preserving pixel-aware collision-free spacing.
 *
 * Zero DOM dependencies — 100% deterministic & unit-testable.
 */

export const GRAPH_LAYOUT_MODES = Object.freeze(['dynamic', 'fixed']);

const DEFAULT_CANVAS_W = 900;
const DEFAULT_CANVAS_H = 460;

function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

export function isEdgeActiveForLayout(edge, visibleIds) {
  if (!edge || !edge.from || !edge.to || edge.from === edge.to) return false;
  if (visibleIds && (!visibleIds.has(edge.from) || !visibleIds.has(edge.to))) return false;
  const status = String(edge.queueStatus || (edge.liveActive ? 'live' : 'ghost')).toLowerCase();
  return status !== 'ghost';
}

/**
 * Classifies visible agents into 'active' (working, urgent, connected to any
 * visible active/queued highway, or recently active within hysteresis window)
 * vs 'dormant' (idle or parked/shell without active graph exchanges).
 */
export function classifyNodeActivityTier(agents = [], edges = [], { recentActiveIds = null, useHysteresis = false } = {}) {
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const visibleIds = new Set(list.map(a => a.id));
  const recentSet = recentActiveIds instanceof Set
    ? recentActiveIds
    : new Set(Array.isArray(recentActiveIds) ? recentActiveIds : []);

  const activeEndpoints = new Set();
  const activeEdges = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (isEdgeActiveForLayout(edge, visibleIds)) {
      activeEdges.push(edge);
      activeEndpoints.add(edge.from);
      activeEndpoints.add(edge.to);
    }
  }

  const tiers = {};
  const activeNodes = [];
  const dormantNodes = [];

  for (const agent of list) {
    const state = String(agent.state || 'idle').toLowerCase();
    const isDirectlyActive = state === 'working' || state === 'urgent' || activeEndpoints.has(agent.id);
    const isHeldByHysteresis = Boolean(useHysteresis && recentSet.has(agent.id));
    if (isDirectlyActive || isHeldByHysteresis) {
      tiers[agent.id] = 'active';
      activeNodes.push(agent);
    } else {
      tiers[agent.id] = 'dormant';
      dormantNodes.push(agent);
    }
  }

  return { tiers, activeNodes, dormantNodes, activeEdges };
}

/**
 * Semantic role tier for deterministic top-to-bottom hierarchy:
 *   0 = Command / Orchestration / Architecture (owner, senior/architect, operator, advisor)
 *   1 = Builders / Coders / Generic agents
 *   2 = Verification / QA (check, qa)
 */
export function getRolePlacementInfo(agent) {
  const id = String((agent && agent.id) || '').toLowerCase();
  const seat = id.includes('@') ? id.slice(0, id.lastIndexOf('@')) : id;

  if (/(check|qa|verif|audit)/i.test(seat)) {
    return { bucket: 2, subRank: 0, seat };
  }
  if (/owner|lead/i.test(seat) && !/advisor/i.test(seat)) {
    return { bucket: 0, subRank: 1, seat };
  }
  if (/senior|architect/i.test(seat)) {
    return { bucket: 0, subRank: 2, seat };
  }
  if (/advisor/i.test(seat)) {
    return { bucket: 0, subRank: 3, seat };
  }
  if (/operator|guardian/i.test(seat)) {
    const isKernel = id.endsWith('@kernel');
    return { bucket: 0, subRank: isKernel ? 0 : 4, seat };
  }
  if (/coder|worker/i.test(seat)) {
    return { bucket: 1, subRank: 0, seat };
  }
  return { bucket: 1, subRank: 5, seat };
}

function sortAgentsDeterministically(list) {
  return [...list].sort((a, b) => {
    const ra = getRolePlacementInfo(a);
    const rb = getRolePlacementInfo(b);
    if (ra.bucket !== rb.bucket) return ra.bucket - rb.bucket;
    if (ra.subRank !== rb.subRank) return ra.subRank - rb.subRank;
    return naturalCompare(a.id, b.id);
  });
}

function getAgentLabelLength(agent) {
  const title = String((agent && (agent.displayTitle || agent.shortName || agent.id)) || '');
  return Math.max(4, title.length);
}

/**
 * Estimates pixel bounding box of a node card for collision & row packing.
 */
export function estimateNodeBox(agent, tier = 'active', { detailed = false } = {}) {
  if (detailed) {
    return { width: 238, height: 116, topExtra: 26 };
  }
  const titleLen = getAgentLabelLength(agent);
  const hasPct = typeof (agent && agent.ctxPct) === 'number' && Number.isFinite(agent.ctxPct);
  const isWaiting = String((agent && agent.state) || '').toLowerCase() === 'waiting';

  if (tier === 'dormant') {
    const flagW = isWaiting ? 42 : 0;
    const pctW = hasPct ? 36 : 0;
    const width = Math.max(76, Math.ceil(20 + titleLen * 6.6 + pctW + flagW));
    return { width, height: 28, topExtra: 6 };
  }

  const hasTokens = hasPct && agent && typeof agent.ctxWindowSize === 'number' && agent.ctxWindowSize > 0;
  const hasCalls = Boolean(agent && ((Number(agent.callsIn) || 0) > 0 || (Number(agent.callsOut) || 0) > 0));
  const pctW = hasPct ? ((agent.ctxPct >= 65) ? 52 : 42) : 0;
  const row1W = 24 + titleLen * 7.5 + pctW;
  const row2W = 24 + (hasTokens ? 74 : 0) + (hasCalls ? 66 : 0) + (hasTokens && hasCalls ? 14 : 0);
  const width = Math.max(158, Math.ceil(Math.max(row1W, row2W)));
  const height = (hasTokens || hasCalls) ? 54 : 38;
  return { width, height, topExtra: 28 };
}

function resolveBox(agent, tier, { detailed = false, measuredBoxes = null } = {}) {
  const m = measuredBoxes && agent && measuredBoxes[agent.id];
  if (
    m &&
    typeof m.width === 'number' && m.width > 30 &&
    typeof m.height === 'number' && m.height > 16 &&
    m.tier === tier &&
    Boolean(m.detailed) === Boolean(detailed)
  ) {
    return {
      width: m.width,
      height: m.height,
      topExtra: detailed ? 26 : (tier === 'dormant' ? 6 : 28)
    };
  }
  return estimateNodeBox(agent, tier, { detailed });
}

function intersectRectBorderDist(hw, hh, ux, uy) {
  const tx = Math.abs(ux) > 1e-5 ? hw / Math.abs(ux) : 1e9;
  const ty = Math.abs(uy) > 1e-5 ? hh / Math.abs(uy) : 1e9;
  return Math.min(tx, ty);
}

function distributeRowX(items, cw, padX) {
  const n = items.length;
  if (n === 0) return [];
  if (n === 1) return [cw / 2];

  const totalCardW = items.reduce((sum, it) => sum + it.box.width, 0);
  const minSpanLeft = padX + items[0].box.width / 2;
  const maxSpanRight = cw - padX - items[n - 1].box.width / 2;

  if (maxSpanRight <= minSpanLeft) {
    return items.map((_, i) => cw * (0.16 + (0.68 * i) / Math.max(1, n - 1)));
  }

  const usableSpan = cw - padX * 2;
  const freeGap = usableSpan - totalCardW;
  if (freeGap >= (n - 1) * 14) {
    // Generous inner gaps between cards while keeping clean outer margins
    const edgeFactor = n === 2 ? 0.48 : (n === 3 ? 0.12 : 0.10);
    const stepGap = freeGap / ((n - 1) + edgeFactor * 2);
    const out = [];
    let cursor = padX + stepGap * edgeFactor;
    for (let i = 0; i < n; i++) {
      out.push(cursor + items[i].box.width / 2);
      cursor += items[i].box.width + stepGap;
    }
    return out;
  }

  // Tight canvas fallback: spread centers evenly from minSpanLeft to maxSpanRight
  return items.map((_, i) => minSpanLeft + ((maxSpanRight - minSpanLeft) * i) / (n - 1));
}

function splitIntoBalancedRows(items, usableW, minGap = 12, maxPerRowCap = 8) {
  if (items.length === 0) return [];
  const totalW = items.reduce((s, it) => s + it.box.width, 0) + Math.max(0, items.length - 1) * minGap;
  if (totalW <= usableW && items.length <= maxPerRowCap) {
    return [items];
  }

  let rowCount = Math.max(2, Math.ceil(totalW / Math.max(160, usableW)));
  rowCount = Math.min(items.length, Math.max(rowCount, Math.ceil(items.length / maxPerRowCap)));

  for (let tries = 0; tries < 6; tries++) {
    const rows = [];
    const baseSize = Math.floor(items.length / rowCount);
    let extra = items.length % rowCount;
    let idx = 0;
    let overflow = false;
    for (let r = 0; r < rowCount; r++) {
      const sz = baseSize + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      const slice = items.slice(idx, idx + sz);
      idx += sz;
      const rw = slice.reduce((s, it) => s + it.box.width, 0) + Math.max(0, slice.length - 1) * minGap;
      if (rw > usableW && slice.length > 1) overflow = true;
      rows.push(slice);
    }
    if (!overflow || rowCount >= items.length) {
      return rows;
    }
    rowCount++;
  }
  return [items];
}

function clampItem(it, cw, minY, maxY, padX = 12) {
  const hw = it.box.width / 2;
  const hh = it.box.height / 2;
  const loX = Math.min(cw / 2, hw + padX);
  const hiX = Math.max(cw / 2, cw - hw - padX);
  const loY = Math.min(maxY, Math.max(minY, hh + (it.box.topExtra || 8)));
  const hiY = Math.max(loY, maxY - hh);
  it.px = Math.max(loX, Math.min(hiX, it.px));
  it.py = Math.max(loY, Math.min(hiY, it.py));
}

function relaxStageItems(items, activeEdges, cw, stageTopY, stageBottomY, {
  gapX = 42,
  gapY = 40,
  edgeClearanceTarget = 148,
  iterations = 36
} = {}) {
  if (items.length <= 1) {
    if (items.length === 1) clampItem(items[0], cw, stageTopY, stageBottomY, 14);
    return;
  }

  const byId = new Map(items.map(it => [it.agent.id, it]));
  const internalEdges = (activeEdges || []).filter(e => byId.has(e.from) && byId.has(e.to));

  for (let iter = 0; iter < iterations; iter++) {
    const damping = 0.42 * (1 - iter / (iterations * 1.45));

    // 1. Pairwise non-overlap repulsion (exact pixel boxes + status-led clearance)
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        let dx = b.px - a.px;
        let dy = b.py - a.py;
        const reqX = (a.box.width + b.box.width) / 2 + gapX;
        const reqY = (a.box.height + b.box.height) / 2 + gapY;
        const ovX = reqX - Math.abs(dx);
        const ovY = reqY - Math.abs(dy);

        if (ovX > 0 && ovY > 0) {
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
            dx = (i % 2 === 0 ? 1 : -1) * 4;
            dy = 2;
          }
          // Prefer separating along the axis that needs less push, with slight X bias
          if (ovX <= ovY * 1.18) {
            const dir = dx >= 0 ? 1 : -1;
            const shift = ovX * 0.52 * damping;
            a.px -= dir * shift;
            b.px += dir * shift;
          } else {
            const dir = dy >= 0 ? 1 : -1;
            const shift = ovY * 0.52 * damping;
            a.py -= dir * shift;
            b.py += dir * shift;
          }
        }
      }
    }

    // 2. Active-edge breathing room so animated arrows & slice badges never collide with cards
    for (const edge of internalEdges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      let dx = b.px - a.px;
      let dy = b.py - a.py;
      let dist = Math.hypot(dx, dy);
      if (dist < 1) {
        dx = 1;
        dy = 0;
        dist = 1;
      }
      const ux = dx / dist;
      const uy = dy / dist;
      const dA = intersectRectBorderDist(a.box.width / 2, a.box.height / 2, ux, uy);
      const dB = intersectRectBorderDist(b.box.width / 2, b.box.height / 2, -ux, -uy);
      const clearGap = dist - dA - dB;

      const sliceTextLen = String(edge.slice && edge.slice !== 'all' ? edge.slice : 'Active').length + 3;
      const badgeEstW = Math.max(84, sliceTextLen * 7.2 + 20);
      const maxFeasibleGap = Math.max(80, Math.min(edgeClearanceTarget, cw * 0.24));
      const desiredGap = Math.min(maxFeasibleGap, Math.max(108, badgeEstW + 36));

      if (clearGap < desiredGap) {
        const push = (desiredGap - clearGap) * 0.45 * damping;
        a.px -= ux * push;
        a.py -= uy * push;
        b.px += ux * push;
        b.py += uy * push;
      }

      // 3. Keep unrelated active nodes clear of the entire edge segment (not just midpoint)
      for (const c of items) {
        if (c === a || c === b) continue;
        const proj = (c.px - a.px) * ux + (c.py - a.py) * uy;
        const t = proj / Math.max(1, dist);
        if (t < 0.12 || t > 0.88) continue;
        const cx = a.px + ux * proj;
        const cy = a.py + uy * proj;
        const mdx = c.px - cx;
        const mdy = c.py - cy;
        const isNearMid = Math.abs(t - 0.5) < 0.24;
        const clearX = c.box.width / 2 + (isNearMid ? badgeEstW / 2 : 16) + 12;
        const clearY = c.box.height / 2 + (isNearMid ? 20 : 14);
        if (Math.abs(mdx) < clearX && Math.abs(mdy) < clearY) {
          // Nudge perpendicular to edge (u, v) away from the segment
          let nx = -uy;
          let ny = ux;
          if (nx * mdx + ny * mdy < 0) {
            nx = -nx;
            ny = -ny;
          }
          if (Math.abs(mdx) < 1 && Math.abs(mdy) < 1) {
            // Exactly collinear: deterministic push away from vertical center
            nx = -uy;
            ny = ux >= 0 ? Math.abs(ux) : -Math.abs(ux);
            if (Math.abs(ny) < 0.1) ny = 1;
          }
          const nudge = Math.min(clearX - Math.abs(mdx), clearY - Math.abs(mdy)) * 0.52 * damping;
          c.px += nx * nudge;
          c.py += ny * nudge;
        }
      }
    }

    for (const it of items) {
      clampItem(it, cw, stageTopY, stageBottomY, 14);
    }
  }
}

function layoutFixedRoleGrid(agents, tiers, cw, ch, { detailed = false, measuredBoxes = null, useActiveSizing = true } = {}) {
  const sorted = sortAgentsDeterministically(agents);
  const items = sorted.map(agent => {
    const boxTier = useActiveSizing ? 'active' : (tiers[agent.id] || 'dormant');
    const box = resolveBox(agent, boxTier, { detailed, measuredBoxes: useActiveSizing ? null : measuredBoxes });
    const role = getRolePlacementInfo(agent);
    return { agent, role, box, px: cw / 2, py: ch / 2 };
  });

  // Group into non-empty role buckets: 0 (Command/Arch), 1 (Coders/Generic), 2 (QA)
  const bucketMap = new Map([[0, []], [1, []], [2, []]]);
  for (const it of items) {
    bucketMap.get(it.role.bucket).push(it);
  }

  const usableW = Math.max(240, cw - 28);
  const allRows = [];
  for (const bucketId of [0, 1, 2]) {
    const group = bucketMap.get(bucketId);
    if (!group || group.length === 0) continue;
    const maxPerRow = bucketId === 1 ? 4 : 5;
    const rows = splitIntoBalancedRows(group, usableW, 18, maxPerRow);
    for (const r of rows) allRows.push(r);
  }

  const topPad = detailed ? 74 : 52;
  const bottomPad = detailed ? 68 : 38;
  const rowCount = allRows.length;
  const rowPitch = rowCount > 1 ? (ch - topPad - bottomPad) / (rowCount - 1) : ch * 0.55;

  allRows.forEach((row, rIdx) => {
    const py = rowCount === 1
      ? ch * 0.46
      : topPad + ((ch - topPad - bottomPad) * rIdx) / Math.max(1, rowCount - 1);
    const xs = distributeRowX(row, cw, 14);
    const maxRowH = Math.max(...row.map(it => it.box.height));
    const staggerRoom = rowPitch - maxRowH - 22;
    const stagger = (row.length >= 3 && staggerRoom > 16)
      ? Math.min(22, Math.max(10, staggerRoom * 0.22))
      : 0;
    row.forEach((it, idx) => {
      it.px = xs[idx];
      if (stagger > 0 && row.length === 3) {
        // Keep apex inside top/bottom bounds instead of clipping against ceiling/floor
        if (rIdx === 0) {
          it.py = idx === 1 ? py : py + stagger * 1.35;
        } else if (rIdx === rowCount - 1 && rowCount > 1) {
          it.py = idx === 1 ? py : py - stagger * 1.35;
        } else {
          it.py = py + (idx === 1 ? -stagger : stagger * 0.75);
        }
      } else if (stagger > 0) {
        it.py = py + (idx % 2 === 0 ? -stagger : stagger);
      } else {
        it.py = py;
      }
      clampItem(it, cw, topPad - 10, ch - 18, 14);
    });
  });

  // Run collision-only relaxation (no edge forces in fixed mode -> invariant to queue/status changes!)
  relaxStageItems(items, [], cw, topPad - 10, ch - 18, {
    gapX: detailed ? 14 : 20,
    gapY: detailed ? 18 : 26,
    edgeClearanceTarget: 0,
    iterations: 22
  });

  return items;
}

function layoutDynamicStage(activeNodes, activeEdges, cw, stageTopY, stageBottomY, { detailed = false, measuredBoxes = null } = {}) {
  const sorted = sortAgentsDeterministically(activeNodes);
  const items = sorted.map(agent => ({
    agent,
    role: getRolePlacementInfo(agent),
    box: resolveBox(agent, 'active', { detailed, measuredBoxes }),
    px: cw / 2,
    py: (stageTopY + stageBottomY) / 2
  }));

  const k = items.length;
  const spanY = Math.max(60, stageBottomY - stageTopY);

  // Degree count across active edges for smart hub ordering
  const degree = new Map(items.map(it => [it.agent.id, 0]));
  const neighbors = new Map(items.map(it => [it.agent.id, new Set()]));
  for (const e of activeEdges) {
    if (degree.has(e.from) && degree.has(e.to)) {
      degree.set(e.from, degree.get(e.from) + 1);
      degree.set(e.to, degree.get(e.to) + 1);
      neighbors.get(e.from).add(e.to);
      neighbors.get(e.to).add(e.from);
    }
  }

  if (k === 1) {
    items[0].px = cw * 0.5;
    items[0].py = stageTopY + spanY * 0.48;
  } else if (k === 2) {
    // Orient primary flow left -> right if an active edge points between them
    const direct = activeEdges.find(e =>
      (e.from === items[0].agent.id && e.to === items[1].agent.id) ||
      (e.from === items[1].agent.id && e.to === items[0].agent.id)
    );
    let ordered = items;
    if (direct && direct.from === items[1].agent.id && items[0].role.bucket === items[1].role.bucket) {
      ordered = [items[1], items[0]];
    }
    const xs = distributeRowX(ordered, cw, Math.max(20, cw * 0.08));
    ordered[0].px = xs[0];
    ordered[1].px = xs[1];
    ordered[0].py = stageTopY + spanY * 0.48;
    ordered[1].py = stageTopY + spanY * 0.48;
  } else if (k === 3) {
    const byBucket = new Map([[0, []], [1, []], [2, []]]);
    for (const it of items) byBucket.get(it.role.bucket).push(it);
    const occupied = [0, 1, 2].map(b => byBucket.get(b)).filter(g => g.length > 0);

    if (occupied.length === 2 && occupied[0].length === 2 && occupied[1].length === 1) {
      // Classic 2-top + 1-bottom wide inverted triangle (e.g. Owner + Architect + QA)
      const topXs = distributeRowX(occupied[0], cw, Math.max(24, cw * 0.07));
      occupied[0][0].px = topXs[0];
      occupied[0][0].py = stageTopY + spanY * 0.22;
      occupied[0][1].px = topXs[1];
      occupied[0][1].py = stageTopY + spanY * 0.22;
      occupied[1][0].px = cw * 0.5;
      occupied[1][0].py = stageTopY + spanY * 0.84;
    } else if (occupied.length === 2 && occupied[0].length === 1 && occupied[1].length === 2) {
      // 1-top + 2-bottom wide apex triangle (e.g. Owner + 2 Coders)
      occupied[0][0].px = cw * 0.5;
      occupied[0][0].py = stageTopY + spanY * 0.18;
      const botXs = distributeRowX(occupied[1], cw, Math.max(24, cw * 0.07));
      occupied[1][0].px = botXs[0];
      occupied[1][0].py = stageTopY + spanY * 0.84;
      occupied[1][1].px = botXs[1];
      occupied[1][1].py = stageTopY + spanY * 0.84;
    } else if (occupied.length === 3) {
      // 3 distinct tiers (e.g. Owner -> Coder -> QA): offset triangle to avoid collinear overlap
      occupied[0][0].px = cw * 0.28;
      occupied[0][0].py = stageTopY + spanY * 0.18;
      occupied[1][0].px = cw * 0.74;
      occupied[1][0].py = stageTopY + spanY * 0.52;
      occupied[2][0].px = cw * 0.34;
      occupied[2][0].py = stageTopY + spanY * 0.86;
    } else {
      // All 3 in same tier: place highest-degree hub at top center, others below left/right
      const hubFirst = [...items].sort((a, b) =>
        (degree.get(b.agent.id) - degree.get(a.agent.id)) || naturalCompare(a.agent.id, b.agent.id)
      );
      hubFirst[0].px = cw * 0.5;
      hubFirst[0].py = stageTopY + spanY * 0.2;
      const botXs = distributeRowX([hubFirst[1], hubFirst[2]], cw, Math.max(24, cw * 0.07));
      hubFirst[1].px = botXs[0];
      hubFirst[1].py = stageTopY + spanY * 0.82;
      hubFirst[2].px = botXs[1];
      hubFirst[2].py = stageTopY + spanY * 0.82;
    }
  } else {
    // 4+ active nodes: collapse empty role buckets & balance wide rows + 1-pass barycenter ordering
    const usableW = Math.max(240, cw - 36);
    const rows = [];
    for (const bucketId of [0, 1, 2]) {
      const group = items.filter(it => it.role.bucket === bucketId);
      if (group.length === 0) continue;
      const subRows = splitIntoBalancedRows(group, usableW, 24, 4);
      for (const sr of subRows) rows.push(sr);
    }

    // If everything landed in 1 bucket with >= 4 items and only 1 row, split into 2 airy rows
    if (rows.length === 1 && rows[0].length >= 4) {
      const half = Math.ceil(rows[0].length / 2);
      const orig = rows[0];
      rows.splice(0, 1, orig.slice(0, half), orig.slice(half));
    }

    const rCount = rows.length;
    const topFrac = rCount === 2 && rows[0].length >= 3 ? 0.26 : 0.14;
    const botFrac = 0.88;
    const rowPitch = rCount > 1 ? (spanY * (botFrac - topFrac)) / (rCount - 1) : spanY * 0.65;

    rows.forEach((row, rIdx) => {
      // For a 3-node row, center the highest-degree hub (or owner/lead) so edges fan out symmetrically
      if (row.length === 3) {
        let hubIdx = 1;
        let bestScore = -1;
        row.forEach((it, idx) => {
          const deg = degree.get(it.agent.id) || 0;
          const isOwner = it.role.bucket === 0 && it.role.subRank === 1 ? 0.5 : 0;
          const score = deg + isOwner;
          if (score > bestScore) {
            bestScore = score;
            hubIdx = idx;
          }
        });
        if (hubIdx !== 1) {
          const hub = row[hubIdx];
          const others = row.filter((_, idx) => idx !== hubIdx);
          row.splice(0, 3, others[0], hub, others[1]);
        }
      }

      const frac = rCount === 1 ? 0.48 : (topFrac + ((botFrac - topFrac) * rIdx) / Math.max(1, rCount - 1));
      const py = stageTopY + spanY * frac;
      const xs = distributeRowX(row, cw, 20);
      const maxRowH = Math.max(...row.map(it => it.box.height));
      const freeY = rowPitch - maxRowH - 18;
      // Anti-collinear arch / stagger: 3+ nodes in one row NEVER sit on a flat horizontal line
      const archDelta = (row.length === 3 && freeY > 14)
        ? Math.min(54, Math.max(18, freeY * 0.38))
        : 0;
      const waveDelta = (row.length >= 4 && freeY > 14)
        ? Math.min(34, Math.max(14, freeY * 0.24))
        : 0;

      row.forEach((it, idx) => {
        it.px = xs[idx];
        if (archDelta > 0) {
          // Top row forms a crisp diamond apex (^), bottom row forms a bowl (v)
          const isBottomRow = rCount > 1 && rIdx === rCount - 1;
          const centerSign = isBottomRow ? 1 : -1;
          it.py = py + (idx === 1 ? centerSign * archDelta : -centerSign * archDelta);
        } else if (waveDelta > 0) {
          it.py = py + (idx % 2 === 0 ? -waveDelta : waveDelta);
        } else {
          it.py = py;
        }
        clampItem(it, cw, stageTopY, stageBottomY, 14);
      });
    });

    // 1-pass barycenter horizontal reorder to minimize crossing highways (preserving anti-collinear stagger)
    const byId = new Map(items.map(it => [it.agent.id, it]));
    for (let rIdx = 1; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (row.length < 2) continue;
      row.sort((a, b) => {
        const bary = (it) => {
          const nbs = [...(neighbors.get(it.agent.id) || [])].map(id => byId.get(id)).filter(Boolean);
          if (nbs.length === 0) return it.px;
          return nbs.reduce((s, n) => s + n.px, 0) / nbs.length;
        };
        const diff = bary(a) - bary(b);
        return Math.abs(diff) > 1 ? diff : naturalCompare(a.agent.id, b.agent.id);
      });
      const xs = distributeRowX(row, cw, 20);
      row.forEach((it, idx) => { it.px = xs[idx]; });
    }
  }

  relaxStageItems(items, activeEdges, cw, stageTopY, stageBottomY, {
    gapX: detailed ? 18 : 42,
    gapY: detailed ? 22 : 42,
    edgeClearanceTarget: detailed ? 110 : 155,
    iterations: 38
  });

  return items;
}

/**
 * Computes normalized (0..100%) positions and activity tiers for all visible agents.
 */
export function computeTopologyLayout({
  agents = [],
  edges = [],
  mode = 'dynamic',
  canvasWidth = DEFAULT_CANVAS_W,
  canvasHeight = DEFAULT_CANVAS_H,
  detailed = false,
  measuredBoxes = null,
  recentActiveIds = null
} = {}) {
  const safeMode = GRAPH_LAYOUT_MODES.includes(mode) ? mode : 'dynamic';
  const cw = Math.max(320, Number(canvasWidth) || DEFAULT_CANVAS_W);
  const ch = Math.max(240, Number(canvasHeight) || DEFAULT_CANVAS_H);
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];

  const { tiers, activeNodes, dormantNodes, activeEdges } = classifyNodeActivityTier(list, edges, {
    recentActiveIds,
    useHysteresis: safeMode === 'dynamic'
  });

  const positions = {};
  const benchEdgeById = {};
  let benchSeparatorY = null;

  if (list.length === 0) {
    return {
      mode: safeMode,
      positions,
      tiers,
      benchEdgeById,
      benchSeparatorY,
      activeCount: 0,
      dormantCount: 0
    };
  }

  let placedItems = [];

  if (safeMode === 'fixed') {
    // Fixed mode: invariant role-tiered layout sized for active cards so waking up never shifts positions
    placedItems = layoutFixedRoleGrid(list, tiers, cw, ch, {
      detailed,
      measuredBoxes,
      useActiveSizing: true
    });
  } else if (activeNodes.length === 0) {
    // Dynamic mode fallback when 100% of fleet is asleep: spacious full-canvas role layout
    placedItems = layoutFixedRoleGrid(list, tiers, cw, ch, {
      detailed,
      measuredBoxes,
      useActiveSizing: false
    });
  } else if (dormantNodes.length === 0) {
    // Dynamic mode when 0 dormant nodes (or hideIdleNodes ON): active stage owns 100% height
    const stageTopY = detailed ? 74 : 46;
    const stageBottomY = ch - (detailed ? 64 : 26);
    placedItems = layoutDynamicStage(activeNodes, activeEdges, cw, stageTopY, stageBottomY, {
      detailed,
      measuredBoxes
    });
  } else {
    // Dynamic Stage + Compact Dormant Bench
    const sortedDormant = sortAgentsDeterministically(dormantNodes);
    const dormantItems = sortedDormant.map(agent => ({
      agent,
      box: resolveBox(agent, 'dormant', { detailed, measuredBoxes }),
      px: cw / 2,
      py: ch - 26
    }));

    const usableW = Math.max(220, cw - 28);
    const gapX = detailed ? 14 : 10;
    const dormantRows = splitIntoBalancedRows(dormantItems, usableW, gapX, detailed ? 4 : 9);
    const rowPitchY = detailed ? 124 : 36;
    const bottomCenterPad = detailed ? 66 : 24;
    const maxBenchH = Math.max(60, ch * (detailed ? 0.44 : 0.34));
    const effectivePitchY = dormantRows.length > 1
      ? Math.min(rowPitchY, (maxBenchH - bottomCenterPad) / Math.max(1, dormantRows.length - 1))
      : rowPitchY;

    const topBenchRowCenterY = ch - bottomCenterPad - (dormantRows.length - 1) * effectivePitchY;
    const topBenchRowTopEdge = topBenchRowCenterY - (detailed ? 58 : 14);
    const separatorPx = Math.max(ch * 0.52, topBenchRowTopEdge - 18);
    benchSeparatorY = Number(((separatorPx / ch) * 100).toFixed(2));

    dormantRows.forEach((row, rIdx) => {
      const py = topBenchRowCenterY + rIdx * effectivePitchY;
      const totalRowW = row.reduce((s, it) => s + it.box.width, 0) + Math.max(0, row.length - 1) * gapX;
      if (totalRowW <= usableW) {
        let cursor = (cw - totalRowW) / 2;
        row.forEach(it => {
          it.px = cursor + it.box.width / 2;
          it.py = py;
          cursor += it.box.width + gapX;
          clampItem(it, cw, separatorPx + 8, ch - 8, 10);
        });
      } else {
        const xs = distributeRowX(row, cw, 12);
        row.forEach((it, idx) => {
          it.px = xs[idx];
          it.py = py;
          clampItem(it, cw, separatorPx + 8, ch - 8, 10);
        });
      }
    });

    const stageTopY = detailed ? 70 : 46;
    const stageBottomY = Math.max(stageTopY + 72, separatorPx - (detailed ? 64 : 34));
    const stageItems = layoutDynamicStage(activeNodes, activeEdges, cw, stageTopY, stageBottomY, {
      detailed,
      measuredBoxes
    });

    placedItems = [...stageItems, ...dormantItems];
  }

  for (const it of placedItems) {
    const xPct = Number(((it.px / cw) * 100).toFixed(2));
    const yPct = Number(((it.py / ch) * 100).toFixed(2));
    positions[it.agent.id] = { x: xPct, y: yPct };
    if (tiers[it.agent.id] === 'dormant') {
      const flags = [];
      if (yPct >= 72) flags.push('bottom');
      if (xPct <= 18) flags.push('left');
      else if (xPct >= 82) flags.push('right');
      if (flags.length) benchEdgeById[it.agent.id] = flags.join(' ');
    }
  }

  return {
    mode: safeMode,
    positions,
    tiers,
    benchEdgeById,
    benchSeparatorY,
    activeCount: activeNodes.length,
    dormantCount: dormantNodes.length
  };
}

/**
 * Computes edge-clamped, flip-aware coordinates for an anchored popover (e.g. Edge X-Ray)
 * inside a container (.canvas-wrap) so it opens right beside the click point without clipping.
 */
export function computeAnchoredPopoverRect({
  anchorX,
  anchorY,
  containerW,
  containerH,
  popoverW,
  popoverH,
  pad = 12,
  offset = 16
} = {}) {
  const cw = Math.max(0, Number(containerW) || 0);
  const ch = Math.max(0, Number(containerH) || 0);
  const pw = Math.max(0, Number(popoverW) || 0);
  const ph = Math.max(0, Number(popoverH) || 0);
  const p = Math.max(0, Number(pad) || 0);
  const gap = Math.max(0, Number(offset) || 0);

  const ax = Number.isFinite(Number(anchorX)) ? Number(anchorX) : cw / 2;
  const ay = Number.isFinite(Number(anchorY)) ? Number(anchorY) : ch / 2;

  const bound = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const maxLeft = Math.max(p, cw - p - pw);
  const maxTop = Math.max(p, ch - p - ph);

  const desiredLeft = ax - pw / 2;
  const left = Math.round(bound(desiredLeft, p, maxLeft));

  const belowTop = ay + gap;
  const aboveTop = ay - gap - ph;

  let top;
  let placement;
  if (belowTop + ph <= ch - p) {
    top = belowTop;
    placement = 'below';
  } else if (aboveTop >= p) {
    top = aboveTop;
    placement = 'above';
  } else {
    // Tight viewport: pick the side with more vertical room and clamp safely inside bounds
    const roomBelow = ch - p - ay;
    const roomAbove = ay - p;
    top = roomBelow >= roomAbove ? bound(belowTop, p, maxTop) : bound(aboveTop, p, maxTop);
    placement = 'clamped';
  }

  return {
    left,
    top: Math.round(bound(top, p, maxTop)),
    placement
  };
}
