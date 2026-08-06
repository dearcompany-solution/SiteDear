// api/naver-detail.js — 네이버 대용량 보고서(AD_DETAIL·EXPKEYWORD) 수집
//
//  하루만        : /api/naver-detail?secret=XXX&date=2026-08-05
//  기간          : /api/naver-detail?secret=XXX&since=2026-08-01&until=2026-08-05
//  최근 N일      : /api/naver-detail?secret=XXX&days=14
//  이미 받은 날도: ...&force=1

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
  const BUDGET = Math.min(Math.max(parseInt(q.budget || '40', 10), 10), 280) * 1000;
  const iso = d => d.toISOString().slice(0, 10);
  const YESTERDAY = iso(new Date(Date.now() - 864e5));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 처리할 날짜 목록
  let dates = [];
  if (q.date) {
    dates = [q.date];
  } else if (q.since && q.until) {
    let d = new Date(q.since + 'T00:00:00Z');
    const e = new Date((q.until > YESTERDAY ? YESTERDAY : q.until) + 'T00:00:00Z');
    while (d <= e && dates.length < 400) { dates.push(iso(d)); d = new Date(d.getTime() + 864e5); }
  } else {
    const n = Math.min(Math.max(parseInt(q.days || '14', 10), 1), 400);
    for (let i = 0; i < n; i++) dates.push(iso(new Date(Date.now() - (i + 1) * 864e5)));
  }
  dates = dates.filter(d => d <= YESTERDAY).sort().reverse();
  if (!dates.length) return res.status(200).json({ done: true, message: '처리할 날짜 없음' });

  // 계정
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
    const hdr = (m, uri) => {
      const ts = Date.now().toString();
      return { 'X-Timestamp': ts, 'X-API-KEY': ak, 'X-CUSTOMER': String(acc.customer_id),
        'X-Signature': crypto.createHmac('sha256', sk).update(`${ts}.${m}.${uri}`).digest('base64'),
        'Content-Type': 'application/json' };
    };
    return {
      get: async (uri, qs) => {
        const r = await fetch(BASE + uri + (qs ? '?' + qs : ''), { headers: hdr('GET', uri) });
        const t = await r.text();
        let b; try { b = JSON.parse(t); } catch (e) { b = t; }
        return { status: r.status, body: b };
      },
      post: async (uri, payload) => {
        const r = await fetch(BASE + uri, { method: 'POST', headers: hdr('POST', uri), body: JSON.stringify(payload) });
        const t = await r.text();
        let b; try { b = JSON.parse(t); } catch (e) { b = t; }
        return { status: r.status, body: b };
      },
      download: async (url) => {
        const r = await fetch(url, { headers: hdr('GET', '/report-download') });
        return r.ok ? await r.text() : '';
      }
    };
  }

  // 보고서 1종 생성 → 완성 대기 → 내려받기
  async function fetchReport(cl, reportTp, date) {
    const mk = await cl.post('/stat-reports', { reportTp, statDt: `${date}T00:00:00.000Z` });
    if (mk.status !== 200 || !mk.body || !mk.body.reportJobId) {
      throw new Error(`${reportTp} 생성 실패: ${JSON.stringify(mk.body).slice(0,150)}`);
    }
    const jobId = mk.body.reportJobId;
    for (let i = 0; i < 25; i++) {
      if (Date.now() - t0 > BUDGET) throw new Error('시간 초과');
      await sleep(1200);
      const st = await cl.get(`/stat-reports/${jobId}`);
      const s = st.body && st.body.status;
      if (s === 'BUILT' && st.body.downloadUrl) {
        const txt = await cl.download(st.body.downloadUrl);
        return txt.split('\n').filter(Boolean).map(l => l.split('\t'));
      }
      if (s === 'ERROR' || s === 'NONE') return [];
    }
    throw new Error(`${reportTp} 생성 지연`);
  }

  const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };

  async function syncDay(acc, date) {
    const cl = api(acc);
    const log = { customer_id: acc.customer_id, client_key: acc.client_key,
      date_from: date, date_to: date, status: 'running', rows_upserted: 0 };
    try {
      // AD_DETAIL — 시간대 · 기기 · 키워드
      const det = await fetchReport(cl, 'AD_DETAIL', date);
      const detRows = det.filter(r => r.length >= 16).map(r => ({
        client_key: acc.client_key, customer_id: acc.customer_id, date,
        campaign_id: r[2] || null, adgroup_id: r[3] || null,
        keyword_id: (r[4] && r[4] !== '-') ? r[4] : null,
        ad_id: r[5] || null, bizchannel_id: r[6] || null,
        hour: num(r[7]), media_code: r[8] || null, bid: num(r[9]),
        device: r[10] || null, imp: num(r[11]), clk: num(r[12]),
        cost: num(r[13]), rank_sum: num(r[14]), conv: num(r[15]), source: 'api'
      }));

      // EXPKEYWORD — 실제 검색어
      const exp = await fetchReport(cl, 'EXPKEYWORD', date);
      const expRows = exp.filter(r => r.length >= 12).map(r => ({
        client_key: acc.client_key, customer_id: acc.customer_id, date,
        campaign_id: r[2] || null, adgroup_id: r[3] || null,
        search_term: r[4] || null, bid: num(r[5]), device: r[6] || null,
        imp: num(r[8]), clk: num(r[9]), cost: num(r[10]), conv: num(r[11]), source: 'api'
      }));

      // 저장 (해당 날짜 API 데이터만 교체)
      for (const [table, rows] of [['naver_detail_data', detRows], ['naver_searchterm_data', expRows]]) {
        const del = await fetch(`${SB}/rest/v1/${table}?customer_id=eq.${encodeURIComponent(acc.customer_id)}&date=eq.${date}&source=eq.api`,
          { method: 'DELETE', headers: sbH });
        if (!del.ok) throw new Error(`${table} 삭제 실패: ` + await del.text());
        for (let i = 0; i < rows.length; i += 500) {
          const ins = await fetch(`${SB}/rest/v1/${table}`, { method: 'POST',
            headers: { ...sbH, 'Prefer': 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
          if (!ins.ok) throw new Error(`${table} 삽입 실패: ` + await ins.text());
        }
      }

      log.rows_upserted = detRows.length + expRows.length;
      log.status = 'success';
      log.detail_rows = detRows.length;
      log.term_rows = expRows.length;
    } catch (e) {
      log.status = 'error';
      log.error_message = String(e.message || e).slice(0, 500);
    }
    try {
      const { detail_rows, term_rows, ...row } = log;
      await fetch(`${SB}/rest/v1/naver_sync_log`, { method: 'POST',
        headers: { ...sbH, 'Prefer': 'return=minimal' }, body: JSON.stringify(row) });
    } catch (e) {}
    return log;
  }

  // 이미 받은 날 건너뛰기 (이번 달은 항상 다시)
  let tasks = [];
  for (const d of dates) for (const acc of accounts) tasks.push({ d, acc });

  if (q.force !== '1') {
    try {
      const r = await fetch(`${SB}/rest/v1/naver_detail_data?select=customer_id,date&limit=20000`, { headers: sbH });
      const rows = await r.json();
      if (Array.isArray(rows)) {
        const has = new Set(rows.map(x => `${x.customer_id}|${x.date}`));
        const thisMonth = YESTERDAY.slice(0, 7);
        tasks = tasks.filter(t => t.d.slice(0, 7) === thisMonth || !has.has(`${t.acc.customer_id}|${t.d}`));
      }
    } catch (e) {}
  }

  const results = [];
  let done = 0;
  for (const t of tasks) {
    if (Date.now() - t0 > BUDGET) break;
    const log = await syncDay(t.acc, t.d);
    results.push({ date: t.d, client: t.acc.client_key, status: log.status,
      detail: log.detail_rows ?? 0, terms: log.term_rows ?? 0, error: log.error_message || null });
    done++;
  }

  return res.status(200).json({
    done: done >= tasks.length, total: tasks.length, processed: done,
    remaining: Math.max(0, tasks.length - done),
    elapsed_sec: Math.round((Date.now() - t0) / 1000), results
  });
}
