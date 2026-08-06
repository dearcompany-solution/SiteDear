// api/naver-test.js — 네이버 검색광고 API 연결 테스트 (일회용)
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
    return res.status(500).json({
      error: '환경변수 누락',
      has_customer: !!CUSTOMER_ID,
      has_apikey: !!API_KEY,
      has_secret: !!SECRET_KEY
    });
  }

  // 네이버는 요청마다 HMAC-SHA256 서명이 필요하다
  function headers(method, uri) {
    const ts = Date.now().toString();
    const sign = crypto
      .createHmac('sha256', SECRET_KEY)
      .update(`${ts}.${method}.${uri}`)
      .digest('base64');
    return {
      'X-Timestamp': ts,
      'X-API-KEY': API_KEY,
      'X-CUSTOMER': String(CUSTOMER_ID),
      'X-Signature': sign,
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

  const out = { customer_id: CUSTOMER_ID };

  // 1) 캠페인 목록 — 연결 자체가 되는지
  const camp = await call('/ncc/campaigns');
  out.campaigns = {
    status: camp.status,
    count: Array.isArray(camp.body) ? camp.body.length : null,
    sample: Array.isArray(camp.body)
      ? camp.body.slice(0, 5).map(c => ({ id: c.nccCampaignId, name: c.name, type: c.campaignTp, status: c.status }))
      : camp.body
  };

  // 2) 최근 7일 성과 — 통계 조회가 되는지
  const to = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  if (Array.isArray(camp.body) && camp.body.length) {
    const ids = camp.body.slice(0, 5).map(c => c.nccCampaignId);
    const stat = await call('/stats',
      `ids=${encodeURIComponent(JSON.stringify(ids))}` +
      `&fields=${encodeURIComponent(JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ccnt']))}` +
      `&timeRange=${encodeURIComponent(JSON.stringify({ since: from, until: to }))}`
    );
    out.stats = { period: `${from} ~ ${to}`, status: stat.status, body: stat.body };
  } else {
    out.stats = '캠페인이 없어 통계 조회를 건너뜀';
  }

  return res.status(200).json(out);
}
