// api/naver-probe.js — 기기/시간대 통계 파라미터 탐색
import crypto from 'crypto';

export default async function handler(req, res) {
  const q = req.query || {};
  if (q.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const BASE = 'https://api.searchad.naver.com';
  const CID = process.env.NAVER_CUSTOMER_ID;
  const AK = process.env.NAVER_API_KEY;
  const SK = process.env.NAVER_SECRET_KEY;

  function headers(uri) {
    const ts = Date.now().toString();
    return { 'X-Timestamp': ts, 'X-API-KEY': AK, 'X-CUSTOMER': String(CID),
      'X-Signature': crypto.createHmac('sha256', SK).update(`${ts}.GET.${uri}`).digest('base64'),
      'Content-Type': 'application/json' };
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
  const F = encodeURIComponent(JSON.stringify(['impCnt','clkCnt','salesAmt','ccnt']));

  const camps = await call('/ncc/campaigns');
  const ids = Array.isArray(camps.body) ? camps.body.map(c => c.nccCampaignId) : [];
  const idP = ids.map(i => `ids=${encodeURIComponent(i)}`).join('&');

  const out = { period: `${since} ~ ${until}` };

  // 여러 파라미터 이름을 시도해 실제로 쪼개지는 것을 찾는다
  const tries = {
    breakdown_pcMobile: `${idP}&fields=${F}&timeRange=${tr}&breakdown=pcMobile`,
    breakdown_hourly:   `${idP}&fields=${F}&timeRange=${tr}&breakdown=hourly`,
    timeIncrement_allDays: `${idP}&fields=${F}&timeRange=${tr}&timeIncrement=allDays`,
    timeIncrement_1:    `${idP}&fields=${F}&timeRange=${tr}&timeIncrement=1`,
    datePreset:         `${idP}&fields=${F}&datePreset=lastweek`
  };
  out.stats_tries = {};
  for (const [k, qs] of Object.entries(tries)) {
    const r = await call('/stats', qs);
    const rows = (r.body && r.body.data) || [];
    out.stats_tries[k] = { status: r.status, rows: rows.length, first: rows[0] || (r.body && r.body.data ? null : r.body) };
  }

  // 마스터 리포트 방식이 있는지 확인
  out.master = {};
  for (const t of ['Campaign','Adgroup','Keyword']) {
    const r = await call('/master-reports');
    out.master.list = { status: r.status, body: Array.isArray(r.body) ? r.body.slice(0,3) : r.body };
    break;
  }
  const sr = await call('/stat-reports');
  out.stat_reports = { status: sr.status, body: Array.isArray(sr.body) ? sr.body.slice(0,5) : sr.body };

  // 키워드 통계는 노출 있는 키워드로 다시 확인
  const grp = await call('/ncc/adgroups', `nccCampaignId=${encodeURIComponent(ids[0])}`);
  if (Array.isArray(grp.body) && grp.body.length) {
    const kw = await call('/ncc/keywords', `nccAdgroupId=${encodeURIComponent(grp.body[0].nccAdgroupId)}`);
    if (Array.isArray(kw.body) && kw.body.length) {
      const kwIds = kw.body.slice(0, 40).map(k => `ids=${encodeURIComponent(k.nccKeywordId)}`).join('&');
      const kst = await call('/stats', `${kwIds}&fields=${F}&timeRange=${tr}`);
      const rows = (kst.body && kst.body.data) || [];
      out.keyword_stats = { status: kst.status, tried: Math.min(40, kw.body.length),
        rows: rows.length, with_data: rows.filter(r => r.impCnt > 0).slice(0, 5) };
    }
  }

  return res.status(200).json(out);
}
