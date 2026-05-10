// Cloudflare Pages Function: /api/leader
// BlogPulse pipeline leader election (work-priority preemptive)
//
// State stored in REFRESH_KV under key 'pipeline_leader':
//   { device_id, priority, host, lease_until_ms, claimed_at_ms }
//
// Priority semantics:
//   work computer = 10 (highest, preemptive)
//   home computer = 5
//   any other     = 1
//
// Algorithm (server-side):
//   POST /api/leader  body { device_id, priority, host }
//     → If no current leader OR lease expired → grant lock to caller.
//     → If current leader == caller → renew lease (heartbeat).
//     → If caller.priority > leader.priority → PREEMPT (caller takes over).
//     → If caller.priority < leader.priority → reject (standby).
//     → If equal priority and leader still alive → reject.
//   Lease length: 30 seconds. Daemon should heartbeat every 10-15s.
//
// GET /api/leader  → returns current leader state (no auth)
// DELETE /api/leader  body { device_id } → release lock if you own it

const KEY = "friend_pipeline_leader";  // 朋友版独立 KV key（避免和主 dashboard 互相覆盖）
const LEASE_MS = 30 * 1000;  // 30s — daemon must heartbeat within this window

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function readLeader(env) {
  if (!env.REFRESH_KV) return null;
  const v = await env.REFRESH_KV.get(KEY);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

async function writeLeader(env, obj) {
  if (!env.REFRESH_KV) return false;
  await env.REFRESH_KV.put(KEY, JSON.stringify(obj));
  return true;
}

export async function onRequestGet({ env }) {
  if (!env.REFRESH_KV) {
    return json({ ok: false, error: "REFRESH_KV not bound" }, 500);
  }
  const cur = await readLeader(env);
  const now = Date.now();
  if (cur && cur.lease_until_ms && cur.lease_until_ms < now) {
    // Stale leader — report but mark expired
    return json({ ok: true, leader: cur, expired: true, now });
  }
  return json({ ok: true, leader: cur, expired: false, now });
}

export async function onRequestPost({ request, env }) {
  if (!env.REFRESH_KV) {
    return json({ ok: false, error: "REFRESH_KV not bound" }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad JSON" }, 400); }
  const device_id = (body?.device_id || "").trim();
  const priority = Number(body?.priority) || 1;
  const host = (body?.host || "").trim();
  if (!device_id) return json({ ok: false, error: "missing device_id" }, 400);

  const now = Date.now();
  const cur = await readLeader(env);
  const leaseExpired = !cur || !cur.lease_until_ms || cur.lease_until_ms < now;

  // Case 1: no leader / lease expired → take lock
  if (!cur || leaseExpired) {
    const next = { device_id, priority, host, lease_until_ms: now + LEASE_MS, claimed_at_ms: now };
    await writeLeader(env, next);
    return json({ ok: true, leader: next, action: "claimed", reason: leaseExpired ? "stale" : "empty" });
  }

  // Case 2: caller is current leader → renew
  if (cur.device_id === device_id) {
    const next = { ...cur, priority, host, lease_until_ms: now + LEASE_MS };
    await writeLeader(env, next);
    return json({ ok: true, leader: next, action: "renewed" });
  }

  // Case 3: caller has higher priority → PREEMPT
  if (priority > (cur.priority || 0)) {
    const next = { device_id, priority, host, lease_until_ms: now + LEASE_MS, claimed_at_ms: now, preempted_from: cur.device_id };
    await writeLeader(env, next);
    return json({ ok: true, leader: next, action: "preempted", from: cur.device_id });
  }

  // Case 4: caller is standby (lower or equal priority, leader alive)
  return json({ ok: true, leader: cur, action: "standby" });
}

export async function onRequestDelete({ request, env }) {
  if (!env.REFRESH_KV) {
    return json({ ok: false, error: "REFRESH_KV not bound" }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad JSON" }, 400); }
  const device_id = (body?.device_id || "").trim();
  if (!device_id) return json({ ok: false, error: "missing device_id" }, 400);
  const cur = await readLeader(env);
  if (!cur) return json({ ok: true, action: "no_leader" });
  if (cur.device_id !== device_id) {
    return json({ ok: false, error: "not the leader", current_leader: cur.device_id }, 403);
  }
  await env.REFRESH_KV.delete(KEY);
  return json({ ok: true, action: "released" });
}
