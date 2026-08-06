// api/naver-probe.js — statType / stat-report 탐색
import crypto from 'crypto';

export default async function handler(req, res) {
  const q = req.query || {};
  if (q.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const BASE = 'https://api.searchad.naver.com';
  const CID = process.env.NAVER_CUSTOMER_ID;
  const AK = process.env.NAVER_API_KEY;
  const SK = process.env.NAVER_SECRET_KEY;

  function hdr(method, uri) {
    const ts = Date.now().toString();
    return { 'X-Timestamp': ts, 'X-API-KEY': AK, 'X-CUSTOMER': String(CID),
      'X-Signature': crypto.createHmac('sha256', SK).update(`${ts}.${method}.${uri}`).digest('base64'),
      'Content-Type': 'application/json' };
  }
  async function call(uri, query) {
    const r = await fetch(BASE + uri + (query ? '?' + query : ''), { headers: hdr('GET', uri) });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 250); }
    return { status: r.status, body: b };
  }
  async function post(uri, payload) {
    const r = await fetch(BASE + uri, { method: 'POST', headers: hdr('POST', uri), body: JSON.stringify(payload) });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 250); }
    return { status: r.status, body: b };
  }

  const since = q.since || '2026-08-01';
  const until = q.until || '2026-08-05';
  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const F = encodeURIComponent(JSON.stringify(['impCnt','clkCnt','salesAmt','ccnt']));

  const camps = await call('/ncc/campaigns');
  const ids = Array.isArray(camps.body) ? camps.body.map(c => c.nccCampaignId) : [];
  const idP = ids.map(i => `ids=${encodeURIComponent(i)}`).join('&');
  const out = { period: `${since} ~ ${until}`, campaigns: ids.length };

  // statType 값들을 시도한다
  const types = ['AD_DETAIL','AD_CONVERSION_DETAIL','CAMPAIGN_DETAIL','ADGROUP_DETAIL','KEYWORD_DETAIL','SHOPPINGKEYWORD_DETAIL','NPLA_SCH_KEYWORD'];
  out.statType = {};
  for (const t of types) {
    const r = await call('/stats', `${idP}&fields=${F}&timeRange=${tr}&statType=${t}`);
    const rows = (r.body && r.body.data) || [];
    out.statType[t] = { status: r.status, rows: rows.length,
      first: rows[0] || (r.body && r.body.data ? null : r.body) };
  }

  // 대용량 보고서로 만들 수 있는 종류를 시도한다
  const reps = ['AD','AD_DETAIL','CAMPAIGN','ADGROUP','KEYWORD','AD_CONVERSION','EXPKEYWORD','TIME','MEDIA'];
  out.statReport = {};
  for (const tp of reps) {
    const r = await post('/stat-reports', { reportTp: tp, statDt: `${until}T00:00:00.000Z` });
    out.statReport[tp] = { status: r.status,
      id: r.body && r.body.reportJobId ? r.body.reportJobId : null,
      msg: r.body && r.body.reportJobId ? null : r.body };
  }

  // 생성 요청한 보고서 목록
  const list = await call('/stat-reports');
  out.reportList = { status: list.status,
    items: Array.isArray(list.body) ? list.body.map(x => ({ tp: x.reportTp, st: x.status, id: x.reportJobId })) : list.body };

  return res.status(200).json(out);
}
