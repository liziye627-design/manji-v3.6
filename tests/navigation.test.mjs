import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { isWalkable, segmentIsWalkable, planPath } from '../public/room/navigation.js';

const tableConfig = {
  bounds: { xMin: 0, xMax: 6, zMin: 0, zMax: 4 },
  obstacles: [{ id: 'table', xMin: 2.3, xMax: 3.7, zMin: 1.3, zMax: 2.7 }],
  agentRadius: 0.2,
  cellSize: 0.12,
};
const start = { x: 0.7, z: 2 };
const goal = { x: 5.3, z: 2 };

function checkPath(result, from, to, config) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.path[0], from);
  assert.deepEqual(result.path.at(-1), to);
  for (let i = 1; i < result.path.length; i += 1) {
    assert.equal(segmentIsWalkable(result.path[i - 1], result.path[i], config), true);
    // Independent dense center samples catch snapping and simplification leaks.
    const a = result.path[i - 1];
    const b = result.path[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.005));
    for (let j = 0; j <= n; j += 1) {
      const x = a.x + (b.x - a.x) * j / n;
      const z = a.z + (b.z - a.z) * j / n;
      const r = config.agentRadius;
      assert.ok(x >= config.bounds.xMin + r - 1e-8 && x <= config.bounds.xMax - r + 1e-8);
      assert.ok(z >= config.bounds.zMin + r - 1e-8 && z <= config.bounds.zMax - r + 1e-8);
      for (const obstacle of config.obstacles ?? []) {
        assert.ok(x < obstacle.xMin - r || x > obstacle.xMax + r
          || z < obstacle.zMin - r || z > obstacle.zMax + r, `Inside ${obstacle.id} at ${x},${z}`);
      }
      for (const dog of config.dogs ?? []) {
        if (config.agentId != null && dog.id === config.agentId) continue;
        assert.ok(Math.hypot(x - dog.x, z - dog.z) > r + dog.radius - 1e-8);
      }
    }
  }
}

test('open-room route preserves exact continuous endpoints and simplifies to one segment', () => {
  const config = { ...tableConfig, obstacles: [] };
  const from = { x: 0.713, z: 0.743 };
  const to = { x: 5.147, z: 3.123 };
  const route = planPath(from, to, config);
  checkPath(route, from, to, config);
  assert.equal(route.path.length, 2);
  assert.equal(route.reason, 'direct');
  assert.equal(route.distance, Math.hypot(to.x - from.x, to.z - from.z));
});

test('table detour is feasible and close to the analytical shortest inflated-rectangle route', () => {
  const route = planPath(start, goal, tableConfig);
  checkPath(route, start, goal, tableConfig);
  const lowerBound = 2 * Math.hypot(1.4, 0.9) + 1.8;
  assert.ok(route.distance >= lowerBound - 1e-8);
  assert.ok(route.distance < lowerBound + 0.28, `${route.distance} vs ${lowerBound}`);
  assert.ok(route.path.length >= 4);
  assert.ok(route.path.length < route.rawWaypointCount);
  assert.ok(route.distance <= route.gridCost + 1e-8);
});

test('blocked target fails with obstacle identity and never snaps to another side', () => {
  const blocked = { x: 3, z: 2 };
  const route = planPath(start, blocked, tableConfig);
  assert.equal(route.ok, false);
  assert.equal(route.reason, 'goal_blocked');
  assert.deepEqual(route.blockedBy, { kind: 'obstacle', id: 'table' });
  assert.deepEqual(route.path, []);
});

test('outside targets and inadequate wall clearance have different explicit failures', () => {
  assert.equal(planPath(start, { x: 6.01, z: 2 }, tableConfig).reason, 'goal_outside_bounds');
  const nearWall = planPath(start, { x: 5.95, z: 2 }, tableConfig);
  assert.equal(nearWall.reason, 'goal_blocked');
  assert.equal(nearWall.blockedBy.kind, 'boundary_clearance');
  assert.equal(segmentIsWalkable(start, { x: 6.01, z: 2 }, tableConfig), false);
});

test('free target enclosed by four barriers returns unreachable', () => {
  const config = {
    bounds: { xMin: 0, xMax: 5, zMin: 0, zMax: 5 }, agentRadius: 0.1,
    obstacles: [
      { xMin: 1.4, xMax: 3.6, zMin: 1.4, zMax: 1.6 },
      { xMin: 1.4, xMax: 3.6, zMin: 3.4, zMax: 3.6 },
      { xMin: 1.4, xMax: 1.6, zMin: 1.4, zMax: 3.6 },
      { xMin: 3.4, xMax: 3.6, zMin: 1.4, zMax: 3.6 },
    ],
  };
  assert.equal(isWalkable({ x: 2.5, z: 2.5 }, config), true);
  const route = planPath({ x: 0.5, z: 0.5 }, { x: 2.5, z: 2.5 }, config);
  assert.equal(route.reason, 'unreachable');
  assert.deepEqual(route.path, []);
});

test('diagonal corner contact cannot leak out of an enclosed corner', () => {
  const config = {
    bounds: { xMin: 0, xMax: 3, zMin: 0, zMax: 3 }, agentRadius: 0,
    obstacles: [
      { id: 'east', xMin: 1, xMax: 2, zMin: 0, zMax: 1 },
      { id: 'north', xMin: 0, xMax: 1, zMin: 1, zMax: 2 },
    ],
  };
  const from = { x: 0.5, z: 0.5 };
  const to = { x: 1.5, z: 1.5 };
  assert.equal(segmentIsWalkable(from, to, config), false);
  assert.equal(planPath(from, to, config).reason, 'unreachable');
});

test('near-grid start connects through visible neighbors rather than snapping into furniture', () => {
  const config = {
    bounds: { xMin: 0, xMax: 3, zMin: 0, zMax: 3 }, agentRadius: 0.1, cellSize: 0.12,
    obstacles: [{ id: 'cabinet', xMin: 1.2, xMax: 1.4, zMin: 0.7, zMax: 1.3 }],
  };
  const from = { x: 1.095, z: 1.1 };
  const to = { x: 2.5, z: 2.5 };
  assert.equal(isWalkable(from, config), true);
  assert.equal(segmentIsWalkable(from, to, config), false);
  checkPath(planPath(from, to, config), from, to, config);
});

test('agent inflation closes a narrow passage that a smaller dog can traverse', () => {
  const config = {
    bounds: { xMin: 0, xMax: 4, zMin: 0, zMax: 4 }, agentRadius: 0.2,
    obstacles: [
      { xMin: 1.9, xMax: 2.1, zMin: 0, zMax: 1.65 },
      { xMin: 1.9, xMax: 2.1, zMin: 2.35, zMax: 4 },
    ],
  };
  const from = { x: 0.6, z: 2 };
  const to = { x: 3.4, z: 2 };
  checkPath(planPath(from, to, config), from, to, config);
  assert.equal(planPath(from, to, { ...config, agentRadius: 0.36 }).reason, 'unreachable');
});

test('another circular dog is avoided while the current dog can be excluded by id', () => {
  const config = {
    ...tableConfig, obstacles: [], agentRadius: 0.22, agentId: 'me',
    dogs: [{ id: 'me', ...start, radius: 0.22 }, { id: 'other', x: 3, z: 2, radius: 0.3 }],
  };
  assert.equal(isWalkable(start, config), true);
  assert.equal(segmentIsWalkable(start, goal, config), false);
  const route = planPath(start, goal, config);
  checkPath(route, start, goal, config);
  assert.ok(route.distance > 4.7);
  assert.deepEqual(planPath(start, { x: 3, z: 2 }, config).blockedBy, { kind: 'dog', id: 'other' });
});

test('dynamic updates invalidate a formerly clear next segment', () => {
  const config = { ...tableConfig, obstacles: [], dogs: [] };
  const route = planPath(start, goal, config);
  assert.equal(route.reason, 'direct');
  const moved = { ...config, dogs: [{ id: 'moving', x: 3, z: 2, radius: 0.3 }] };
  assert.equal(segmentIsWalkable(route.path[0], route.path[1], moved), false);
  checkPath(planPath(start, goal, moved), start, goal, moved);
});

test('continuous AABB intersection detects an arbitrarily thin crossing between endpoints', () => {
  const config = {
    bounds: { xMin: 0, xMax: 5, zMin: 0, zMax: 3 }, agentRadius: 0,
    obstacles: [{ xMin: 2.0001, xMax: 2.0002, zMin: 0.5, zMax: 1.5 }],
  };
  const a = { x: 0.5, z: 1.01 };
  const b = { x: 4.5, z: 1.01 };
  assert.equal(isWalkable(a, config), true);
  assert.equal(isWalkable(b, config), true);
  assert.equal(segmentIsWalkable(a, b, config), false);
  assert.equal(segmentIsWalkable(b, a, config), false);
});

test('circle tangency is blocked; a small positive clearance is walkable', () => {
  const config = { ...tableConfig, obstacles: [], dogs: [{ x: 3, z: 2, radius: 0.3 }] };
  assert.equal(segmentIsWalkable({ x: 0.5, z: 1.5 }, { x: 5.5, z: 1.5 }, config), false);
  assert.equal(segmentIsWalkable({ x: 0.5, z: 1.49 }, { x: 5.5, z: 1.49 }, config), true);
});

test('same valid target produces one exact waypoint; a blocked same target still fails', () => {
  const route = planPath(start, { ...start }, tableConfig);
  assert.equal(route.reason, 'already_at_goal');
  assert.deepEqual(route.path, [start]);
  assert.equal(route.distance, 0);
  assert.equal(planPath({ x: 3, z: 2 }, { x: 3, z: 2 }, tableConfig).ok, false);
});

test('tiny clear room does not need a usable grid when the direct segment is safe', () => {
  const config = { bounds: { xMin: 0, xMax: 0.2, zMin: 0, zMax: 0.2 }, agentRadius: 0.09 };
  const a = { x: 0.095, z: 0.095 };
  const b = { x: 0.105, z: 0.105 };
  checkPath(planPath(a, b, config), a, b, config);
});

test('search budgets report failure instead of returning an unsafe partial path', () => {
  const route = planPath(start, goal, { ...tableConfig, maxExpandedNodes: 1 });
  assert.equal(route.reason, 'search_limit');
  assert.equal(route.expandedNodes, 1);
  assert.deepEqual(route.path, []);
});

test('invalid geometry and non-finite points fail closed', () => {
  assert.equal(planPath({ x: NaN, z: 1 }, goal, tableConfig).reason, 'invalid_start');
  assert.equal(planPath(start, { x: Infinity, z: 1 }, tableConfig).reason, 'invalid_goal');
  const bad = { ...tableConfig, agentRadius: -1 };
  assert.equal(planPath(start, goal, bad).reason, 'invalid_config');
  assert.equal(isWalkable(start, bad), false);
  assert.equal(segmentIsWalkable(start, goal, bad), false);
  assert.equal(planPath(start, goal, { ...tableConfig, cellSize: 0.000001 }).reason, 'grid_too_large');
});

test('planning is deterministic and does not mutate caller data', () => {
  const config = structuredClone(tableConfig);
  const original = JSON.stringify(config);
  const first = planPath(start, goal, config);
  assert.deepEqual(planPath(start, goal, config), first);
  assert.equal(JSON.stringify(config), original);
  first.path[0].x = 123;
  assert.equal(start.x, 0.7);
});

test('measured room layout exposes the genuinely closed sofa/table passage at radius 0.38', () => {
  const config = {
    bounds: { xMin: -2.93, xMax: 3.041, zMin: -2.32, zMax: 2.509 },
    agentRadius: 0.38,
    obstacles: [
      { id: 'sofa', xMin: -2.5678, xMax: 0.2078, zMin: -1.3032, zMax: 0.130717 },
      { id: 'table', xMin: 0.804, xMax: 2.316, zMin: 0.62324, zMax: 1.69676 },
      { id: 'lamp', xMin: -2.95418, xMax: -2.12582, zMin: -1.73418, zMax: -0.90582 },
      { id: 'bookshelf', xMin: 2.0655, xMax: 2.9545, zMin: -0.643, zMax: -0.2958 },
      { id: 'rearplant', xMin: 2.01599, xMax: 2.91031, zMin: -2.34487, zMax: -1.44588 },
      { id: 'frontplant', xMin: -2.88498, xMax: -2.37141, zMin: 1.05027, zMax: 1.56653 },
      { id: 'window', xMin: 0.22, xMax: 2.46, zMin: -2.525, zMax: -2.01 },
    ],
  };
  const from = { x: -1.45, z: 1.1 };
  const frontGoal = { x: 0.2, z: 1.7 };
  const rearGoal = { x: 1.25, z: -1.0 };
  checkPath(planPath(from, frontGoal, config), from, frontGoal, config);
  assert.equal(isWalkable(rearGoal, config), true);
  assert.equal(planPath(from, rearGoal, config).reason, 'unreachable');
});


const finalLayout = JSON.parse(readFileSync(new URL('../public/assets/models/room-layout.json', import.meta.url), 'utf8'));
const finalDogs = Object.entries(finalLayout.spawns).map(([id, p]) => ({ id, x: p.x, z: p.z, radius: finalLayout.agentRadius }));
const xz = p => ({ x: p.x, z: p.z });

test('delivered room layout has safe separated spawns and statically reachable lounge waypoints', () => {
  const config = { ...finalLayout, cellSize: 0.09 };
  assert.equal(finalDogs.length, 3);
  for (const dog of finalDogs) {
    assert.equal(isWalkable(dog, config), true, dog.id);
    for (const other of finalDogs) {
      if (dog === other) continue;
      assert.ok(Math.hypot(dog.x - other.x, dog.z - other.z) > dog.radius + other.radius);
    }
    for (const goal of finalLayout.waypoints) {
      assert.equal(isWalkable(goal, config), true, goal.id);
      checkPath(planPath(dog, goal, config), xz(dog), xz(goal), config);
    }
    assert.equal(planPath(dog, { x: 1.25, z: -1 }, config).reason, 'unreachable');
  }
});

test('each delivered dog has at least two real initial roaming options with the other dogs present', () => {
  for (const dog of finalDogs) {
    const config = { ...finalLayout, cellSize: 0.09, dogs: finalDogs, agentId: dog.id };
    let roamingOptions = 0;
    for (const goal of finalLayout.waypoints) {
      const route = planPath(dog, goal, config);
      if (route.ok) {
        checkPath(route, xz(dog), xz(goal), config);
        if (Math.hypot(dog.x - goal.x, dog.z - goal.z) > 0.6) roamingOptions += 1;
      } else {
        assert.equal(route.reason, 'goal_blocked', `${dog.id} to ${goal.id}`);
        assert.equal(route.blockedBy.kind, 'dog');
      }
    }
    assert.ok(roamingOptions >= 2, `${dog.id}: ${roamingOptions} reachable long routes`);
  }
});

test('delivered layout rejects a shared destination after a previous dog arrives there', () => {
  const dogs = structuredClone(finalDogs);
  const shiba = dogs.find(d => d.id === 'shiba');
  const husky = dogs.find(d => d.id === 'husky');
  const goal = finalLayout.waypoints.find(p => p.id === 'rug_front');
  const before = { ...finalLayout, cellSize: 0.09, dogs, agentId: shiba.id };
  checkPath(planPath(shiba, goal, before), xz(shiba), xz(goal), before);
  shiba.x = goal.x;
  shiba.z = goal.z;
  const after = { ...finalLayout, cellSize: 0.09, dogs, agentId: husky.id };
  const result = planPath(husky, goal, after);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'goal_blocked');
  assert.deepEqual(result.blockedBy, { kind: 'dog', id: 'shiba' });
  assert.equal(segmentIsWalkable(husky, goal, after), false);
});
