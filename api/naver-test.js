// api/naver-sync.js — 네이버 검색광고 데이터 동기화
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
  const BUDGET = Math.min(Math.max(parseInt(q.budget || '35', 10), 10), 280) * 1000;
  const iso = d => d.toISOString().slice(0, 10);
  const YESTERDAY = iso(new Date(Date.now() - 864e5));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function monthChunk(m) {
    const [y, mo] = String(m).split('-').map(Number);
    if (!y || !mo || mo < 1 || mo > 12) return null;
    return { label: `${y}-${String(mo).padStart(2,'0')}`,
      since: iso(new Date(Date.UTC(y, mo-1, 1))), until: iso(new Date(Date.UTC(y, mo, 0))) };
  }
  function monthRange(a, b) {
    if (!monthChunk(a) || !monthChunk(b)) return [];
    const out = []; let [y, m] = a.split('-').map(Number);
    const [ey, em] = b.split('-').map(Number);
    for (let i = 0; i < 40; i++) {
      if (y > ey || (y === ey && m > em)) break;
      const c = monthChunk(`${y}-${String(m).padStart(2,'0')}`);
      if (c) out.push(c);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // 기간 결정
  let chunks = [];
  if (q.month) {
    const c = monthChunk(q.month);
    if (!c) return res.status(400).json({ error: 'month 형식 오류 (예: 2026-07)' });
    chunks = [c];
  } else if (q.from && q.to) {
    chunks = monthRange(q.from, q.to);
  } else if (q.months) {
    const n = Math.min(Math.max(parseInt(q.months, 10), 1), 24);
    const d = new Date();
    const start = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n + 1, 1))).slice(0,7);
    chunks = monthRange(start, YESTERDAY.slice(0,7));
  } else {
    const days = Math.min(Math.max(parseInt(q.days || '14', 10), 1), 92);
    chunks = [{ label: `최근 ${days}일`,
      since: iso(new Date(Date.now() - days * 864e5)), until: YESTERDAY }];
  }
  chunks = chunks.map(c => ({ ...c, until: c.until > YESTERDAY ? YESTERDAY : c.until }))
                 .filter(c => c.since <= c.until);
  if (!chunks.length) return res.status(200).json({ done: true, message: '처리할 기간 없음' });

  // 계정 목록
  let accounts = [];
  try {
    let url = `${SB}/rest/v1/naver_ad_accounts?is_active=eq.true&select=client_key,customer_id,api_key,secret_key`;
    if (q.client) url += `&client_key=eq.${encodeURIComponent(q.client)}`;
    const r = await fetch(url, { headers: sbH });
    accounts = await r.json();
  } catch (e) {
    return res.status(500).json({ error: '계정 조회 실패: ' + e.message });
  }
  if (!Array.isArray(accounts) || !accounts.length) {
    return res.status(200).json({ done: true, message: '동기화할 계정 없음' });
  }

  const FIELDS = JSON.stringify(['impCnt','clkCnt','salesAmt','ccnt','convAmt','crto','cpc','ctr','avgRnk','viewCnt']);

  function makeCall(acc) {
    const apiKey = acc.api_key === 'ENV' ? process.env.NAVER_API_KEY : acc.api_key;
    const secret = acc.secret_key === 'ENV' ? process.env.NAVER_SECRET_KEY : acc.secret_key;
    return async function (uri, query) {
      const ts = Date.now().toString();
      const sign = crypto.createHmac('sha256', secret).update(`${ts}.GET.${uri}`).digest('base64');
      const r = await fetch(BASE + uri + (query ? '?' + query : ''), {
        headers: { 'X-Timestamp': ts, 'X-API-KEY': apiKey,
          'X-CUSTOMER': String(acc.customer_id), 'X-Signature': sign,
          'Content-Type': 'application/json' }
      });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 300); }
      if (!r.ok) throw new Error(`네이버 API ${r.status}: ${JSON.stringify(body).slice(0,200)}`);
      return body;
    };
  }

  async function syncOne(acc, ch) {
    const log = { customer_id: acc.customer_id, client_key: acc.client_key,
      date_from: ch.since, date_to: ch.until, status: 'running', rows_upserted: 0 };
    try {
      const call = makeCall(acc);
      const camps = await call('/ncc/campaigns');
      if (!Array.isArray(camps) || !camps.length) throw new Error('캠페인 없음');

      const nameMap = {}, typeMap = {};
      camps.forEach(c => { nameMap[c.nccCampaignId] = c.name; typeMap[c.nccCampaignId] = c.campaignTp; });
      const idParam = camps.map(c => `ids=${encodeURIComponent(c.nccCampaignId)}`).join('&');

      // 일별로 조회 (네이버 stats는 기간 합산이라 하루씩 나눔)
      const rows = [];
      let d = new Date(ch.since + 'T00:00:00Z');
      const end = new Date(ch.until + 'T00:00:00Z');
      while (d <= end) {
        if (Date.now() - t0 > BUDGET) break;
        const day = iso(d);
        const st = await call('/stats',
          `${idParam}&fields=${encodeURIComponent(FIELDS)}` +
          `&timeRange=${encodeURIComponent(JSON.stringify({ since: day, until: day }))}`);
        ((st && st.data) || []).forEach(r => {
          const cost = Number(r.salesAmt) || 0;
          const convAmt = Number(r.convAmt) || 0;
          if (!cost && !Number(r.impCnt)) return;
          rows.push({
            client_key: acc.client_key, customer_id: acc.customer_id, date: day,
            campaign_id: r.id, campaign_name: nameMap[r.id] || null,
            campaign_type: typeMap[r.id] || null,
            imp: Number(r.impCnt) || 0, clk: Number(r.clkCnt) || 0, cost,
            conv: Number(r.ccnt) || 0, conv_amt: convAmt,
            ctr: r.ctr ?? null, cpc: r.cpc ?? null, crto: r.crto ?? null,
            avg_rnk: r.avgRnk ?? null, view_cnt: Number(r.viewCnt) || 0,
            roas: cost > 0 ? +(convAmt / cost).toFixed(4) : null,
            source: 'api', raw: r
          });
        });
        d = new Date(d.getTime() + 864e5);
        await sleep(300);
      }

      const del = await fetch(`${SB}/rest/v1/naver_ad_data?customer_id=eq.${encodeURIComponent(acc.customer_id)}&date=gte.${ch.since}&date=lte.${ch.until}&source=eq.api`,
        { method: 'DELETE', headers: sbH });
      if (!del.ok) throw new Error('삭제 실패: ' + await del.text());

      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${SB}/rest/v1/naver_ad_data`,
          { method: 'POST', headers: { ...sbH, 'Prefer': 'return=minimal' },
            body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!ins.ok) throw new Error('삽입 실패: ' + await ins.text());
      }
      log.rows_upserted = rows.length;
      log.status = 'success';
    } catch (e) {
      log.status = 'error';
      log.error_message = String(e.message || e).slice(0, 500);
    }
    try {
      await fetch(`${SB}/rest/v1/naver_sync_log`, { method: 'POST',
        headers: { ...sbH, 'Prefer': 'return=minimal' }, body: JSON.stringify(log) });
    } catch (e) {}
    return log;
  }

  const tasks = [];
  for (const ch of chunks) for (const acc of accounts) tasks.push({ ch, acc });

  const results = [];
  let done = 0;
  for (const t of tasks) {
    if (Date.now() - t0 > BUDGET) break;
    const log = await syncOne(t.acc, t.ch);
    results.push({ period: t.ch.label, client: t.acc.client_key,
      status: log.status, rows: log.rows_upserted, error: log.error_message || null });
    done++;
  }

  const remaining = tasks.length - done;
  return res.status(200).json({
    done: remaining === 0, accounts: accounts.length,
    total: tasks.length, processed: done, remaining,
    elapsed_sec: Math.round((Date.now() - t0) / 1000), results
  });
}
