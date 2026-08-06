
// api/naver-keywords.js — 네이버 키워드 ID ↔ 이름 매핑 수집
//
//  전체 수집 : /api/naver-keywords?secret=XXX
//  특정 업체 : /api/naver-keywords?secret=XXX&client=디어컴퍼니

import crypto from 'crypto';

export default async function handler(req, res) {
  const q = req.query || {};
  const ok = q.secret === process.env.CRON_SECRET
    || (req.headers['authorization'] === 'Bearer ' + process.env.CRON_SECRET);
  if (!ok) return res.status(401).json({ error: 'unauthorized' });

  const BASE = 'https://api.searchad.naver.com';
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbH = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  const t0 = Date.now();
  const BUDGET = Math.min(Math.max(parseInt(q.budget || '45', 10), 10), 280) * 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let accounts = [];
  try {
    let url = `${SB}/rest/v1/naver_ad_accounts?is_active=eq.true&select=client_key,customer_id,api_key,secret_key`;
    if (q.client) url += `&client_key=eq.${encodeURIComponent(q.client)}`;
    accounts = await (await fetch(url, { headers: sbH })).json();
  } catch (e) { return res.status(500).json({ error: '계정 조회 실패: ' + e.message }); }
  if (!Array.isArray(accounts) || !accounts.length) {
    return res.status(200).json({ done: true, message: '동기화할 계정 없음' });
  }

  function api(acc) {
    const ak = acc.api_key === 'ENV' ? process.env.NAVER_API_KEY : acc.api_key;
    const sk = acc.secret_key === 'ENV' ? process.env.NAVER_SECRET_KEY : acc.secret_key;
    return async (uri, qs) => {
      const ts = Date.now().toString();
      const sign = crypto.createHmac('sha256', sk).update(`${ts}.GET.${uri}`).digest('base64');
      const r = await fetch(BASE + uri + (qs ? '?' + qs : ''), {
        headers: { 'X-Timestamp': ts, 'X-API-KEY': ak, 'X-CUSTOMER': String(acc.customer_id),
          'X-Signature': sign, 'Content-Type': 'application/json' }
      });
      const txt = await r.text();
      let body; try { body = JSON.parse(txt); } catch (e) { body = txt.slice(0, 300); }
      if (!r.ok) throw new Error(`${uri} ${r.status}: ${JSON.stringify(body).slice(0, 180)}`);
      return body;
    };
  }

  const results = [];

  for (const acc of accounts) {
    const out = { client: acc.client_key, campaigns: 0, adgroups: 0, keywords: 0, error: null };
    try {
      const call = api(acc);
      const camps = await call('/ncc/campaigns');
      if (!Array.isArray(camps)) throw new Error('캠페인 응답 형식 오류');
      out.campaigns = camps.length;

      const rows = [];
      for (const c of camps) {
        if (Date.now() - t0 > BUDGET) { out.error = '시간 초과 — 다시 호출하세요'; break; }
        let groups = [];
        try {
          groups = await call('/ncc/adgroups', 'nccCampaignId=' + encodeURIComponent(c.nccCampaignId));
        } catch (e) { continue; }
        if (!Array.isArray(groups)) continue;
        out.adgroups += groups.length;

        for (const g of groups) {
          if (Date.now() - t0 > BUDGET) { out.error = '시간 초과 — 다시 호출하세요'; break; }
          let kws = [];
          try {
            kws = await call('/ncc/keywords', 'nccAdgroupId=' + encodeURIComponent(g.nccAdgroupId));
          } catch (e) { continue; }
          if (!Array.isArray(kws)) continue;
          kws.forEach(k => rows.push({
            client_key: acc.client_key,
            customer_id: String(acc.customer_id),
            keyword_id: k.nccKeywordId,
            keyword: k.keyword || null,
            adgroup_id: g.nccAdgroupId,
            campaign_id: c.nccCampaignId,
            updated_at: new Date().toISOString()
          }));
          await sleep(120);
        }
      }

      const seen = new Set();
      const uniq = rows.filter(r => {
        const k = r.client_key + '|' + r.keyword_id;
        if (!r.keyword_id || seen.has(k)) return false;
        seen.add(k); return true;
      });

      for (let i = 0; i < uniq.length; i += 500) {
        const ins = await fetch(`${SB}/rest/v1/naver_keywords?on_conflict=client_key,keyword_id`, {
          method: 'POST',
          headers: { ...sbH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(uniq.slice(i, i + 500))
        });
        if (!ins.ok) throw new Error('저장 실패: ' + (await ins.text()).slice(0, 200));
      }
      out.keywords = uniq.length;
    } catch (e) {
      out.error = String(e.message || e).slice(0, 300);
    }
    results.push(out);
  }

  return res.status(200).json({
    done: results.every(r => !r.error),
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
    results
  });
}
