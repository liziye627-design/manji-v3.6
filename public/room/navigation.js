/**
 * Framework-independent, conservative navigation on the room's X/Z plane.
 *
 * Points: { x, z }. Config:
 * { bounds: {xMin,xMax,zMin,zMax}, obstacles?: [AABB], agentRadius,
 *   dogs?: [{id?,x,z,radius}], agentId?, cellSize?: 0.12,
 *   connectorCells?: 4, maxExpandedNodes?: 50000, maxGridNodes?: 200000 }
 *
 * AABBs and circles are closed obstacles; touching an inflated obstacle is
 * blocked. Room bounds shrink by agentRadius. Every returned segment is checked
 * continuously, including start/goal connectors and simplification shortcuts.
 * Dogs describe a snapshot: a moving application should recheck the next segment
 * against its current config and replan when another dog moves into the route.
 *
 * A* is optimal on the constructed eight-neighbor grid. It does not promise the
 * exact continuous-space shortest path or completeness below grid resolution.
 */

const EPS = 1e-9;
const NEIGHBORS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validPoint = point => point != null && finite(point.x) && finite(point.z);
const copyPoint = point => ({ x: point.x, z: point.z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function validBox(box, strict = false) {
  return box != null && ['xMin', 'xMax', 'zMin', 'zMax'].every(key => finite(box[key]))
    && (strict ? box.xMin < box.xMax && box.zMin < box.zMax
      : box.xMin <= box.xMax && box.zMin <= box.zMax);
}

function makeWorld(config) {
  if (config == null || !validBox(config.bounds, true)) {
    return { error: 'bounds must contain finite, increasing X/Z limits' };
  }
  if (!finite(config.agentRadius) || config.agentRadius < 0) {
    return { error: 'agentRadius must be a finite nonnegative number' };
  }
  const cellSize = config.cellSize ?? 0.12;
  const connectorCells = config.connectorCells ?? 4;
  const maxExpandedNodes = config.maxExpandedNodes ?? 50000;
  const maxGridNodes = config.maxGridNodes ?? 200000;
  if (!finite(cellSize) || cellSize <= 0) return { error: 'cellSize must be positive' };
  if (!Number.isInteger(connectorCells) || connectorCells < 1 || connectorCells > 64) {
    return { error: 'connectorCells must be an integer from 1 to 64' };
  }
  if (!Number.isInteger(maxExpandedNodes) || maxExpandedNodes < 1
      || !Number.isInteger(maxGridNodes) || maxGridNodes < 1) {
    return { error: 'search limits must be positive integers' };
  }
  const boxes = config.obstacles ?? [];
  const dogs = config.dogs ?? [];
  if (!Array.isArray(boxes) || !Array.isArray(dogs)) {
    return { error: 'obstacles and dogs must be arrays' };
  }
  if (boxes.some(box => !validBox(box))) return { error: 'invalid obstacle AABB' };
  if (dogs.some(dog => !validPoint(dog) || !finite(dog.radius) || dog.radius < 0)) {
    return { error: 'dogs need finite x, z and nonnegative radius' };
  }
  const radius = config.agentRadius;
  const bounds = { ...config.bounds };
  const safeBounds = {
    xMin: bounds.xMin + radius, xMax: bounds.xMax - radius,
    zMin: bounds.zMin + radius, zMax: bounds.zMax - radius,
  };
  return {
    bounds, safeBounds, radius, cellSize, connectorCells, maxExpandedNodes, maxGridNodes,
    empty: safeBounds.xMin > safeBounds.xMax || safeBounds.zMin > safeBounds.zMax,
    boxes: boxes.map((box, index) => ({
      id: box.id ?? `obstacle_${index}`,
      xMin: box.xMin - radius, xMax: box.xMax + radius,
      zMin: box.zMin - radius, zMax: box.zMax + radius,
    })),
    circles: dogs.filter(dog => config.agentId == null || dog.id !== config.agentId)
      .map((dog, index) => ({ id: dog.id ?? `dog_${index}`, x: dog.x, z: dog.z, radius: dog.radius + radius })),
  };
}

function within(point, box) {
  return point.x >= box.xMin - EPS && point.x <= box.xMax + EPS
    && point.z >= box.zMin - EPS && point.z <= box.zMax + EPS;
}

function pointBlocker(point, world) {
  if (!within(point, world.bounds)) return { kind: 'outside_bounds' };
  if (world.empty || !within(point, world.safeBounds)) return { kind: 'boundary_clearance' };
  for (const box of world.boxes) {
    if (within(point, box)) return { kind: 'obstacle', id: box.id };
  }
  for (const circle of world.circles) {
    if (Math.hypot(point.x - circle.x, point.z - circle.z) <= circle.radius + EPS) {
      return { kind: 'dog', id: circle.id };
    }
  }
  return null;
}

function segmentHitsBox(a, b, box) {
  let enter = 0;
  let leave = 1;
  for (const [axis, low, high] of [['x', 'xMin', 'xMax'], ['z', 'zMin', 'zMax']]) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < EPS) {
      if (a[axis] < box[low] - EPS || a[axis] > box[high] + EPS) return false;
      continue;
    }
    let near = (box[low] - EPS - a[axis]) / delta;
    let far = (box[high] + EPS - a[axis]) / delta;
    if (near > far) [near, far] = [far, near];
    enter = Math.max(enter, near);
    leave = Math.min(leave, far);
    if (enter > leave) return false;
  }
  return true;
}

function segmentHitsCircle(a, b, circle) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((circle.x - a.x) * dx + (circle.z - a.z) * dz) / lengthSquared));
  return Math.hypot(a.x + t * dx - circle.x, a.z + t * dz - circle.z) <= circle.radius + EPS;
}

function clearSegment(a, b, world) {
  if (pointBlocker(a, world) || pointBlocker(b, world)) return false;
  // The eroded room is convex: valid endpoints keep the entire segment inside.
  return !world.boxes.some(box => segmentHitsBox(a, b, box))
    && !world.circles.some(circle => segmentHitsCircle(a, b, circle));
}

/** Boolean, fail-closed point query. Invalid input/config returns false. */
export function isWalkable(point, config) {
  if (!validPoint(point)) return false;
  const world = makeWorld(config);
  return !world.error && !pointBlocker(point, world);
}

/** Exact continuous line query against inflated AABBs and circular dogs. */
export function segmentIsWalkable(start, goal, config) {
  if (!validPoint(start) || !validPoint(goal)) return false;
  const world = makeWorld(config);
  return !world.error && clearSegment(start, goal, world);
}

class MinHeap {
  items = [];
  static before(a, b) {
    return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.serial < b.serial)));
  }
  push(item) {
    const list = this.items;
    list.push(item);
    let index = list.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!MinHeap.before(list[index], list[parent])) break;
      [list[index], list[parent]] = [list[parent], list[index]];
      index = parent;
    }
  }
  pop() {
    const list = this.items;
    if (!list.length) return null;
    const first = list[0];
    const last = list.pop();
    if (list.length) {
      list[0] = last;
      let index = 0;
      while (true) {
        const left = 2 * index + 1;
        const right = left + 1;
        let next = index;
        if (left < list.length && MinHeap.before(list[left], list[next])) next = left;
        if (right < list.length && MinHeap.before(list[right], list[next])) next = right;
        if (next === index) break;
        [list[index], list[next]] = [list[next], list[index]];
        index = next;
      }
    }
    return first;
  }
}

function pathDistance(path) {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) total += distance(path[i - 1], path[i]);
  return total;
}

function simplify(path, world) {
  const result = [path[0]];
  let index = 0;
  while (index < path.length - 1) {
    let next = path.length - 1;
    while (next > index + 1 && !clearSegment(path[index], path[next], world)) next -= 1;
    if (!clearSegment(path[index], path[next], world)) return null;
    if (distance(result[result.length - 1], path[next]) > EPS) result.push(path[next]);
    index = next;
  }
  return result;
}

function fail(reason, detail = {}) {
  return { ok: false, path: [], reason, distance: 0, expandedNodes: 0, ...detail };
}

/**
 * Returns {ok,path,reason,distance,expandedNodes,gridCost?,grid?,blockedBy?}.
 * No target snapping or partial path is returned on failure.
 */
export function planPath(start, goal, config) {
  if (!validPoint(start)) return fail('invalid_start');
  if (!validPoint(goal)) return fail('invalid_goal');
  const world = makeWorld(config);
  if (world.error) return fail('invalid_config', { detail: world.error });
  if (world.empty) return fail('no_navigable_area');
  for (const [label, point] of [['start', start], ['goal', goal]]) {
    const blocker = pointBlocker(point, world);
    if (blocker) return fail(`${label}_${blocker.kind === 'outside_bounds' ? 'outside_bounds' : 'blocked'}`, { blockedBy: blocker });
  }
  if (distance(start, goal) <= EPS) {
    return { ok: true, path: [copyPoint(start)], reason: 'already_at_goal', distance: 0, expandedNodes: 0 };
  }
  if (clearSegment(start, goal, world)) {
    return { ok: true, path: [copyPoint(start), copyPoint(goal)], reason: 'direct', distance: distance(start, goal), expandedNodes: 0 };
  }
  const safe = world.safeBounds;
  const nx = Math.max(1, Math.ceil((safe.xMax - safe.xMin) / world.cellSize) + 1);
  const nz = Math.max(1, Math.ceil((safe.zMax - safe.zMin) / world.cellSize) + 1);
  const total = nx * nz;
  if (!Number.isSafeInteger(total) || total > world.maxGridNodes) {
    return fail('grid_too_large', { requestedGridNodes: total });
  }
  const stepX = nx > 1 ? (safe.xMax - safe.xMin) / (nx - 1) : 0;
  const stepZ = nz > 1 ? (safe.zMax - safe.zMin) / (nz - 1) : 0;
  const grid = { nx, nz, cellSizeX: stepX, cellSizeZ: stepZ, nodeCount: total };
  const pointAt = index => ({ x: safe.xMin + (index % nx) * stepX, z: safe.zMin + Math.floor(index / nx) * stepZ });
  const occupancy = new Uint8Array(total);
  function nodeIsClear(index) {
    if (!occupancy[index]) occupancy[index] = pointBlocker(pointAt(index), world) ? 2 : 1;
    return occupancy[index] === 1;
  }
  function connectors(point) {
    const centerX = stepX > 0 ? Math.round((point.x - safe.xMin) / stepX) : 0;
    const centerZ = stepZ > 0 ? Math.round((point.z - safe.zMin) / stepZ) : 0;
    const range = world.connectorCells;
    const limit = range * world.cellSize;
    const found = [];
    for (let iz = Math.max(0, centerZ - range); iz <= Math.min(nz - 1, centerZ + range); iz += 1) {
      for (let ix = Math.max(0, centerX - range); ix <= Math.min(nx - 1, centerX + range); ix += 1) {
        const index = iz * nx + ix;
        const node = pointAt(index);
        const cost = distance(point, node);
        if (cost <= limit + EPS && nodeIsClear(index) && clearSegment(point, node, world)) found.push({ index, cost });
      }
    }
    return found.sort((a, b) => a.cost - b.cost || a.index - b.index);
  }
  const fromStart = connectors(start);
  const toGoal = connectors(goal);
  if (!fromStart.length) return fail('start_has_no_grid_connection', { grid });
  if (!toGoal.length) return fail('goal_has_no_grid_connection', { grid });

  const goalIndex = total;
  const goalCosts = new Float64Array(total).fill(Infinity);
  for (const connector of toGoal) goalCosts[connector.index] = connector.cost;
  const costs = new Float64Array(total + 1).fill(Infinity);
  const parents = new Int32Array(total + 1).fill(-1);
  const closed = new Uint8Array(total + 1);
  const open = new MinHeap();
  let serial = 0;
  let expandedNodes = 0;
  function offer(index, cost, parent) {
    if (cost + EPS >= costs[index]) return;
    costs[index] = cost;
    parents[index] = parent;
    const h = index === goalIndex ? 0 : distance(pointAt(index), goal);
    open.push({ index, g: cost, h, f: cost + h, serial: serial++ });
  }
  for (const connector of fromStart) offer(connector.index, connector.cost, -2);
  while (open.items.length) {
    const current = open.pop();
    if (closed[current.index] || current.g > costs[current.index] + EPS) continue;
    if (current.index === goalIndex) {
      const reversed = [copyPoint(goal)];
      let index = parents[goalIndex];
      while (index >= 0) {
        reversed.push(pointAt(index));
        index = parents[index];
      }
      reversed.push(copyPoint(start));
      const rawPath = reversed.reverse();
      const path = simplify(rawPath, world);
      if (!path) return fail('internal_collision_check_failed', { expandedNodes, grid });
      return { ok: true, path, reason: 'path_found', distance: pathDistance(path),
        gridCost: costs[goalIndex], rawWaypointCount: rawPath.length, expandedNodes, grid };
    }
    if (expandedNodes >= world.maxExpandedNodes) return fail('search_limit', { expandedNodes, grid });
    closed[current.index] = 1;
    expandedNodes += 1;
    if (Number.isFinite(goalCosts[current.index])) {
      offer(goalIndex, current.g + goalCosts[current.index], current.index);
    }
    const ix = current.index % nx;
    const iz = Math.floor(current.index / nx);
    const point = pointAt(current.index);
    for (const [dx, dz] of NEIGHBORS) {
      const x = ix + dx;
      const z = iz + dz;
      if (x < 0 || x >= nx || z < 0 || z >= nz) continue;
      const neighbor = z * nx + x;
      if (closed[neighbor] || !nodeIsClear(neighbor)) continue;
      // A diagonal cannot squeeze between blocked orthogonal grid neighbors.
      if (dx && dz && (!nodeIsClear(iz * nx + x) || !nodeIsClear(z * nx + ix))) continue;
      const nextPoint = pointAt(neighbor);
      if (!clearSegment(point, nextPoint, world)) continue;
      offer(neighbor, current.g + distance(point, nextPoint), current.index);
    }
  }
  return fail('unreachable', { expandedNodes, grid });
}
