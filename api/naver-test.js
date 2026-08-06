// api/naver-test.js — 네이버 검색광고 API 연결 테스트
import crypto from 'crypto';

export default async function handler(req, res) {
  const q = req.query || {};
  if (q.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const BASE = 'https://api.searchad.naver.com';
  const CUSTOMER_ID = q.customer || process.env.NAVER_CUSTOMER_ID;
  const API_KEY = process.env.NAVER_API_KEY;
  const SECRET_KEY = process.env.NAVER_SECRET_KEY;

  if (!CUSTOMER_ID || !API_KEY || !SECRET_KEY) {
    return res.status(500).json({ error: '환경변수 누락' });
  }

  function headers(method, uri) {
    const ts = Date.now().toString();
    const sign = crypto.createHmac('sha256', SECRET_KEY)
      .update(`${ts}.${method}.${uri}`).digest('base64');
    return {
      'X-Timestamp': ts, 'X-API-KEY': API_KEY,
      'X-CUSTOMER': String(CUSTOMER_ID), 'X-Signature': sign,
      'Content-Type': 'application/json'
    };
  }

  async function call(uri, query) {
    const url = BASE + uri + (query ? '?' + query : '');
    const r = await fetch(url, { headers: headers('GET', uri) });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 300); }
    return { status: r.status, body };
  }

  const iso = d => d.toISOString().slice(0, 10);
  const out = { customer_id: CUSTOMER_ID };

  // 전체 캠페인
  const camp = await call('/ncc/campaigns');
  if (!Array.isArray(camp.body)) {
    out.campaigns = camp;
    return res.status(200).json(out);
  }

  out.campaign_count = camp.body.length;
  out.by_status = camp.body.reduce((a, c) => {
    a[c.status] = (a[c.status] || 0) + 1; return a;
  }, {});

  const allIds = camp.body.map(c => c.nccCampaignId);
  const idParam = allIds.map(id => `ids=${encodeURIComponent(id)}`).join('&');
  const fields = encodeURIComponent(JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt', 'crto', 'cpc', 'ctr', 'avgRnk', 'viewCnt']));

  // 기간을 나눠 훑으며 데이터가 있는 구간을 찾는다
  async function statFor(since, until) {
    const s = await call('/stats',
      `${idParam}&fields=${fields}` +
      `&timeRange=${encodeURIComponent(JSON.stringify({ since, until }))}`);
    const rows = (s.body && s.body.data) || [];
    const sum = rows.reduce((a, r) => ({
      imp: a.imp + (r.impCnt || 0),
      clk: a.clk + (r.clkCnt || 0),
      cost: a.cost + (r.salesAmt || 0)
    }), { imp: 0, clk: 0, cost: 0 });
    return { period: `${since} ~ ${until}`, status: s.status, rows: rows.length, ...sum };
  }

  // 최근 12개월을 월 단위로 확인
  const probes = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
    const until = iso(e) > iso(now) ? iso(now) : iso(e);
    probes.push(await statFor(iso(s), until));
  }

  out.monthly = probes;
  out.found = probes.filter(p => p.cost > 0 || p.imp > 0);

  // 데이터가 있는 달의 캠페인별 상세
  if (out.found.length) {
    const f = out.found[0];
    const [since, until] = f.period.split(' ~ ');
    const s = await call('/stats',
      `${idParam}&fields=${fields}` +
      `&timeRange=${encodeURIComponent(JSON.stringify({ since, until }))}`);
    const nameMap = {};
    camp.body.forEach(c => { nameMap[c.nccCampaignId] = c.name; });
    out.detail = {
      period: f.period,
      raw_sample: ((s.body && s.body.data) || [])[0] || null,
      rows: ((s.body && s.body.data) || [])
        .filter(r => (r.salesAmt || 0) > 0 || (r.impCnt || 0) > 0)
        .map(r => ({
          campaign: nameMap[r.id] || r.id,
          노출: r.impCnt, 클릭: r.clkCnt,
          광고비: r.salesAmt, 전환: r.ccnt, 전환매출: r.convAmt
        }))
    };
  }

  return res.status(200).json(out);
}
