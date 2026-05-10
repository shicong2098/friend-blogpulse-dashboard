/**
 * /api/search_episodes?q=xxx — 云端复刻 daemon search_episodes endpoint
 *
 * 实现：
 *   1) 加载 dashboard 部署的 channels.json（用户追踪的频道）+ podcast_catalog.json
 *   2) catalog 按名字匹配 query 取前 5 个频道
 *   3) 加上用户追踪的频道（去重）
 *   4) 并行 fetch xiaoyuzhoufm podcast 页面，从 __NEXT_DATA__ 解析 episodes
 *   5) 按 query 过滤（标题 / 频道名命中），按发布日期降序返回
 *
 * 朋友本地无 daemon 时，前端 fetch 这个 endpoint 替代 daemon 的 /search_episodes
 * 用法：GET /api/search_episodes?q=AI
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
    return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request }) {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    if (!q || q.length < 2) {
        return new Response(JSON.stringify([]), {
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // 1) 拉 channels + catalog（同站静态）
    const origin = url.origin;
    const [channelsR, catalogR] = await Promise.all([
        fetch(`${origin}/blogpulse/channels.json`, { cf: { cacheTtl: 60 } }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        fetch(`${origin}/blogpulse/podcast_catalog.json`, { cf: { cacheTtl: 3600 } }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);

    // 2) catalog 匹配 query → 前 5 个频道（catalog 已按热度排序）
    const catalogHits = [];
    for (const p of catalogR || []) {
        const name = (p.n || '').toLowerCase();
        const author = (p.a || '').toLowerCase();
        if (name.includes(q) || author.includes(q)) {
            catalogHits.push(p.p);
            if (catalogHits.length >= 5) break;
        }
    }

    // 3) 用户追踪的 pids（friend 版 channels.json 通常空 / 几个）
    const trackedPids = (channelsR || [])
        .map((c) => c.podcast_id)
        .filter((p) => p && typeof p === 'string');

    const allPids = [...new Set([...trackedPids, ...catalogHits])].slice(0, 12);
    if (allPids.length === 0) {
        return new Response(JSON.stringify([]), {
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // 4) 并行 fetch xiaoyuzhoufm 解析
    const fetchPodcastEps = async (pid) => {
        try {
            const r = await fetch(`https://www.xiaoyuzhoufm.com/podcast/${pid}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                cf: { cacheTtl: 1800 },
            });
            if (!r.ok) return [];
            const html = await r.text();
            const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (!m) return [];
            const data = JSON.parse(m[1]);
            const podcast = data?.props?.pageProps?.podcast || {};
            const podcastName = podcast.title || '';
            const logo = podcast?.image?.smallPicUrl || '';
            const eps = podcast.episodes || [];
            return eps.map((ep) => ({
                _eid: ep.eid || '',
                title: ep.title || '',
                podcastID: pid,
                podcastName,
                logoURL: logo,
                link: `https://www.xiaoyuzhoufm.com/episode/${ep.eid}`,
                duration: Math.round((ep.duration || 0) / 60),
                postTime: ep.pubDate || '',
                _date: (ep.pubDate || '').slice(0, 10),
            }));
        } catch {
            return [];
        }
    };

    const results = await Promise.all(allPids.map(fetchPodcastEps));

    // 5) 收集 + 过滤 + 排序
    const seen = new Set();
    const out = [];
    const catalogHitSet = new Set(catalogHits);
    for (let i = 0; i < allPids.length; i++) {
        const pid = allPids[i];
        const eps = results[i];
        const wholeChannel = catalogHitSet.has(pid);
        for (const ep of eps) {
            if (!ep._eid || seen.has(ep._eid)) continue;
            const t = (ep.title || '').toLowerCase();
            const pn = (ep.podcastName || '').toLowerCase();
            if (wholeChannel || t.includes(q) || pn.includes(q)) {
                seen.add(ep._eid);
                out.push(ep);
                if (out.length >= 80) break;
            }
        }
        if (out.length >= 80) break;
    }

    out.sort((a, b) => (b.postTime || b._date || '').localeCompare(a.postTime || a._date || ''));

    return new Response(JSON.stringify(out.slice(0, 80)), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}
