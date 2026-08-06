// api/naver-probe.js — 네이버 추가 통계 조회 가능 여부 확인 (일회용)
import crypto from 'crypto';

export default async function handler(req, res) {
  const q = req.query || {};
  if (q.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const BASE = 'https://api.searchad.naver.com';
  const CUSTOMER_ID = process.env.NAVER_CUSTOMER_ID;
  const API_KEY = process.env.NAVER_API_KEY;
  const SECRET_KEY = process.env.NAVER_SECRET_KEY;

  function headers(uri) {
    const ts = Date.now().toString();
    const sign = crypto.createHmac('sha256', SECRET_KEY).update(`${ts}.GET.${uri}`).digest('base64');
    return { 'X-Timestamp': ts, 'X-API-KEY': API_KEY, 'X-CUSTOMER': String(CUSTOMER_ID),
      'X-Signature': sign, 'Content-Type': 'application/json' };
  }
  async function call(uri, query) {
    const r = await fetch(BASE + uri + (query ? '?' + query : ''), { headers: headers(uri) });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 200); }
    return { status: r.status, body: b };
  }

  const since = q.since || '2026-08-01';
  const until = q.until || '2026-08-05';
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const out = { period: `${since} ~ ${until}` };

  const camps = await call('/ncc/campaigns');
  if (!Array.isArray(camps.body)) return res.status(200).json({ error: '캠페인 조회 실패', camps });
  const ids = camps.body.map(c => c.nccCampaignId);
  const idP = ids.map(i => `ids=${encodeURIComponent(i)}`).join('&');
  const F = encodeURIComponent(JSON.stringify(['impCnt','clkCnt','salesAmt','ccnt']));

  // 1) 기기별 (PC/모바일)
  const dev = await call('/stats', `${idP}&fields=${F}&timeRange=${tr}&breakdown=pcMobile`);
  out.device = { status: dev.status, sample: (dev.body && dev.body.data || []).slice(0, 4), raw: dev.body && dev.body.data ? undefined : dev.body };

  // 2) 시간대별
  const hour = await call('/stats', `${idP}&fields=${F}&timeRange=${tr}&breakdown=hourly`);
  out.hourly = { status: hour.status, sample: (hour.body && hour.body.data || []).slice(0, 4), raw: hour.body && hour.body.data ? undefined : hour.body };

  // 3) 광고그룹 목록 (키워드로 내려가는 경로)
  const grp = await call('/ncc/adgroups', `nccCampaignId=${encodeURIComponent(ids[0])}`);
  out.adgroups = { status: grp.status, count: Array.isArray(grp.body) ? grp.body.length : null,
    sample: Array.isArray(grp.body) ? grp.body.slice(0,2).map(g=>({id:g.nccAdgroupId,name:g.name})) : grp.body };

  // 4) 키워드 목록
  if (Array.isArray(grp.body) && grp.body.length) {
    const kw = await call('/ncc/keywords', `nccAdgroupId=${encodeURIComponent(grp.body[0].nccAdgroupId)}`);
    out.keywords = { status: kw.status, count: Array.isArray(kw.body) ? kw.body.length : null,
      sample: Array.isArray(kw.body) ? kw.body.slice(0,3).map(k=>({id:k.nccKeywordId,kw:k.keyword})) : kw.body };

    if (Array.isArray(kw.body) && kw.body.length) {
      const kwIds = kw.body.slice(0,5).map(k=>`ids=${encodeURIComponent(k.nccKeywordId)}`).join('&');
      const kst = await call('/stats', `${kwIds}&fields=${F}&timeRange=${tr}`);
      out.keyword_stats = { status: kst.status, sample: (kst.body && kst.body.data || []).slice(0,3), raw: kst.body && kst.body.data ? undefined : kst.body };
    }
  }

  return res.status(200).json(out);
}
