/**
 * /api/backup — Cloud-side merger for user dashboard data (BlogPulse + trump-tracker + reports).
 *
 * Replaces (in parallel for now) the local daemon's `:9876/backup` endpoint. Same
 * contract as `_smart_merge_user_data` in blogpulse/daemon.pyw — incoming snapshot
 * is FIELD-MERGED with the existing KV value, never overwritten.
 *
 * Body: { data: {key: stringified-JSON, ...}, ts?: ms }
 *
 * Known keys handled:
 *   bp_user_ratings, bp_reads, bp_learned_weights      — flat dict, incoming wins per key
 *   bp_pending_episodes                                — list, dedup by episode_id
 *   bp_annotations         {epId: [items]}             — dedup by id
 *   bp_corrections         {epId: [items]}             — dedup by (original, corrected)
 *   bp_expansions          {epId: {ch: {ts, ...}}}     — latest ts wins per chapter
 *   bp_expand_pending      {epId: {ch: {requested_at, status}}}  — status priority done/error > processing > pending, then ts
 *   bp_channel_actions     [{id, status, ts}]          — dedup by id w/ same priority + 24h cleanup
 *   tt_user_ratings, tt_learned_weights                — flat dict, incoming wins
 *   tt_truth_posts, tt_news_posts                      — list, dedup by id
 *   tt_trans_cache, tt_link_cache                      — flat dict, incoming wins
 *   reports-img-hl-v1::*, reports-hl-v1::*             — per-doc dict, latest ts wins
 *   any other key                                      — preserved (incoming wins on conflict)
 *
 * KV layout: writes to `user_data_sync` as the merged data dict (NOT wrapped in
 * the {updated_at, data: ...} envelope — keep KV value compact).
 * GET on /api/user-data returns the envelope-wrapped form for front-end compat.
 */

function parseStringified(obj, key, fallback) {
    try {
        const s = obj?.[key];
        if (!s) return fallback;
        const v = JSON.parse(s);
        return v == null ? fallback : v;
    } catch {
        return fallback;
    }
}

function asStr(v) {
    return JSON.stringify(v);
}

function mergeFlat(existing, incoming) {
    return { ...existing, ...incoming };
}

function mergeListById(existing, incoming, idKey) {
    const seen = new Set();
    const out = [];
    for (const x of incoming || []) {
        if (x && typeof x === 'object' && x[idKey] != null) {
            seen.add(x[idKey]);
            out.push(x);
        }
    }
    for (const x of existing || []) {
        if (x && typeof x === 'object' && x[idKey] != null && !seen.has(x[idKey])) {
            out.push(x);
        }
    }
    return out;
}

function mergeMapOfListsDedupBy(existing, incoming, dedupFn) {
    const out = {};
    const eps = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
    for (const ep of eps) {
        const aList = (existing || {})[ep] || [];
        const bList = (incoming || {})[ep] || [];
        const seen = new Set();
        const merged = [];
        for (const x of bList) {
            if (x && typeof x === 'object') {
                const k = dedupFn(x);
                if (k != null) seen.add(JSON.stringify(k));
                merged.push(x);
            }
        }
        for (const x of aList) {
            if (x && typeof x === 'object') {
                const k = dedupFn(x);
                if (k != null && seen.has(JSON.stringify(k))) continue;
                merged.push(x);
            }
        }
        out[ep] = merged;
    }
    return out;
}

function mergeExpansions(existing, incoming) {
    const out = {};
    const eps = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
    for (const ep of eps) {
        const aChap = (existing || {})[ep] || {};
        const bChap = (incoming || {})[ep] || {};
        const chapMerged = {};
        const chapters = new Set([...Object.keys(aChap), ...Object.keys(bChap)]);
        for (const ch of chapters) {
            const av = aChap[ch];
            const bv = bChap[ch];
            if (!av) chapMerged[ch] = bv;
            else if (!bv) chapMerged[ch] = av;
            else {
                const aTs = (typeof av === 'object' && av?.ts) || 0;
                const bTs = (typeof bv === 'object' && bv?.ts) || 0;
                chapMerged[ch] = aTs > bTs ? av : bv;
            }
        }
        out[ep] = chapMerged;
    }
    return out;
}

function mergeExpandPending(existing, incoming) {
    const out = {};
    const eps = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
    const rank = { done: 3, error: 3, processing: 2, pending: 1 };
    for (const ep of eps) {
        const aChap = typeof (existing || {})[ep] === 'object' ? (existing || {})[ep] : {};
        const bChap = typeof (incoming || {})[ep] === 'object' ? (incoming || {})[ep] : {};
        const chapMerged = {};
        const chapters = new Set([...Object.keys(aChap), ...Object.keys(bChap)]);
        for (const ch of chapters) {
            const av = aChap[ch];
            const bv = bChap[ch];
            if (!av) chapMerged[ch] = bv;
            else if (!bv) chapMerged[ch] = av;
            else {
                const aTs = (typeof av === 'object' && av?.requested_at) || 0;
                const bTs = (typeof bv === 'object' && bv?.requested_at) || 0;
                const aR = rank[(typeof av === 'object' && av?.status) || 'pending'] || 0;
                const bR = rank[(typeof bv === 'object' && bv?.status) || 'pending'] || 0;
                if (aR !== bR) chapMerged[ch] = aR > bR ? av : bv;
                else chapMerged[ch] = aTs > bTs ? av : bv;
            }
        }
        if (Object.keys(chapMerged).length > 0) out[ep] = chapMerged;
    }
    return out;
}

function mergeChannelActions(existing, incoming) {
    const all = [...(existing || []), ...(incoming || [])].filter((x) => x && typeof x === 'object' && x.id);
    const rankSt = { done: 3, error: 3, processing: 2, pending: 1 };
    const map = new Map();
    for (const x of all) {
        const id = x.id;
        const cur = map.get(id);
        if (!cur) {
            map.set(id, x);
        } else {
            const aR = rankSt[cur.status || 'pending'] || 0;
            const bR = rankSt[x.status || 'pending'] || 0;
            if (bR > aR || (bR === aR && (x.ts || 0) > (cur.ts || 0))) {
                map.set(id, x);
            }
        }
    }
    const nowMs = Date.now();
    return [...map.values()].filter(
        (v) => !((v.status === 'done' || v.status === 'error') && nowMs - (v.completed_at || v.ts || 0) > 86400000),
    );
}

function mergeReportsHighlight(existing, incoming) {
    const a = existing && typeof existing === 'object' ? existing : null;
    const b = incoming && typeof incoming === 'object' ? incoming : null;
    if (!a) return b;
    if (!b) return a;
    const aTs = a._updated_at || 0;
    const bTs = b._updated_at || 0;
    if (aTs === 0 && bTs === 0) return { ...a, ...b };
    return bTs >= aTs ? b : a;
}

function smartMerge(existing, incoming) {
    const out = {};

    // BlogPulse flat keys
    for (const k of ['bp_user_ratings', 'bp_reads', 'bp_learned_weights']) {
        const a = parseStringified(existing, k, {});
        const b = parseStringified(incoming, k, {});
        out[k] = asStr(mergeFlat(a, b));
    }

    // bp_pending_episodes (list dedup by episode_id, incoming first)
    {
        const a = parseStringified(existing, 'bp_pending_episodes', []);
        const b = parseStringified(incoming, 'bp_pending_episodes', []);
        out['bp_pending_episodes'] = asStr(mergeListById(a, b, 'episode_id'));
    }

    // bp_annotations (map of lists, dedup by id)
    {
        const a = parseStringified(existing, 'bp_annotations', {});
        const b = parseStringified(incoming, 'bp_annotations', {});
        out['bp_annotations'] = asStr(mergeMapOfListsDedupBy(a, b, (x) => x?.id));
    }

    // bp_corrections (map of lists, dedup by (original,corrected))
    {
        const a = parseStringified(existing, 'bp_corrections', {});
        const b = parseStringified(incoming, 'bp_corrections', {});
        out['bp_corrections'] = asStr(
            mergeMapOfListsDedupBy(a, b, (x) => [x?.original, x?.corrected]),
        );
    }

    // bp_expansions
    {
        const a = parseStringified(existing, 'bp_expansions', {});
        const b = parseStringified(incoming, 'bp_expansions', {});
        out['bp_expansions'] = asStr(mergeExpansions(a, b));
    }

    // bp_expand_pending
    {
        const a = parseStringified(existing, 'bp_expand_pending', {});
        const b = parseStringified(incoming, 'bp_expand_pending', {});
        out['bp_expand_pending'] = asStr(mergeExpandPending(a, b));
    }

    // bp_channel_actions
    {
        const a = parseStringified(existing, 'bp_channel_actions', []);
        const b = parseStringified(incoming, 'bp_channel_actions', []);
        if (a.length > 0 || b.length > 0) {
            out['bp_channel_actions'] = asStr(mergeChannelActions(a, b));
        }
    }

    // trump-tracker flat
    for (const k of ['tt_user_ratings', 'tt_learned_weights']) {
        const a = parseStringified(existing, k, {});
        const b = parseStringified(incoming, k, {});
        if (Object.keys(a).length > 0 || Object.keys(b).length > 0) {
            out[k] = asStr(mergeFlat(a, b));
        }
    }
    // trump-tracker lists by id
    for (const k of ['tt_truth_posts', 'tt_news_posts']) {
        const a = parseStringified(existing, k, []);
        const b = parseStringified(incoming, k, []);
        if (a.length > 0 || b.length > 0) {
            out[k] = asStr(mergeListById(a, b, 'id'));
        }
    }
    // trump-tracker translation/link caches
    for (const k of ['tt_trans_cache', 'tt_link_cache']) {
        const a = parseStringified(existing, k, {});
        const b = parseStringified(incoming, k, {});
        if (Object.keys(a).length > 0 || Object.keys(b).length > 0) {
            out[k] = asStr(mergeFlat(a, b));
        }
    }

    // reports-read-v1 (flat dict {docId: ms_ts}, latest ts wins per docId)
    {
        const a = parseStringified(existing, 'reports-read-v1', {});
        const b = parseStringified(incoming, 'reports-read-v1', {});
        if (Object.keys(a).length || Object.keys(b).length) {
            const merged = { ...a };
            for (const [k, v] of Object.entries(b)) {
                const lv = a[k];
                const bTs = typeof v === 'number' ? v : v ? 1 : 0;
                const aTs = typeof lv === 'number' ? lv : lv ? 1 : 0;
                if (bTs >= aTs) merged[k] = v;
            }
            out['reports-read-v1'] = asStr(merged);
        }
    }

    // reports highlights with dynamic keys
    const allKeys = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
    for (const k of allKeys) {
        if (k in out) continue;
        if (k.startsWith('reports-img-hl-v1::') || k.startsWith('reports-hl-v1::')) {
            const a = parseStringified(existing, k, null);
            const b = parseStringified(incoming, k, null);
            const merged = mergeReportsHighlight(a, b);
            if (merged != null) out[k] = asStr(merged);
        }
    }

    // Any unhandled key: incoming wins
    for (const [k, v] of Object.entries(incoming || {})) if (!(k in out)) out[k] = v;
    for (const [k, v] of Object.entries(existing || {})) if (!(k in out)) out[k] = v;

    return out;
}

export async function onRequest(context) {
    const { env, request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders(),
        });
    }

    if (request.method === 'GET') {
        const raw = await env.REFRESH_KV.get('user_data_sync');
        const data = raw ? JSON.parse(raw) : {};
        return new Response(
            JSON.stringify({ updated_at: new Date().toISOString(), data }),
            { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } },
        );
    }

    if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: corsHeaders() });
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return new Response('invalid json', { status: 400, headers: corsHeaders() });
    }
    const incoming = payload?.data;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return new Response('payload.data must be an object', { status: 400, headers: corsHeaders() });
    }

    const rawExisting = await env.REFRESH_KV.get('user_data_sync');
    const existing = rawExisting ? JSON.parse(rawExisting) : {};
    const merged = smartMerge(existing, incoming);

    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        await env.REFRESH_KV.put('user_data_sync', JSON.stringify(merged));
    }

    return new Response(
        JSON.stringify({ ok: true, keys: Object.keys(merged), bytes: JSON.stringify(merged).length }),
        { status: 200, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } },
    );
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}
