/**
 * /api/user-data — read-only view into KV's user_data_sync.
 *
 * Returns the same shape the front-end currently fetches from
 * `./blogpulse/user_data_sync.json` so the migration is a one-line front-end change:
 *   fetch('./blogpulse/user_data_sync.json')  →  fetch('./api/user-data')
 *
 * Response: { updated_at: ISO, data: { bp_*: stringified, tt_*: stringified, ... } }
 */
export async function onRequest(context) {
    const { env, request } = context;
    if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
    }
    const raw = await env.REFRESH_KV.get('user_data_sync');
    const data = raw ? JSON.parse(raw) : {};
    return new Response(
        JSON.stringify({ updated_at: new Date().toISOString(), data }, null, 0),
        {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache, no-store',
                'Access-Control-Allow-Origin': '*',
            },
        },
    );
}
