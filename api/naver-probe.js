// api/naver-probe.js — AD_DETAIL 컬럼 의미 확정
import crypto from 'crypto';

export default async function handler(req, res) {
  const q = req.query || {};
  if (q.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const BASE = 'https://api.searchad.naver.com';
  const CID = process.env.NAVER_CUSTOMER_ID;
  const AK = process.env.NAVER_API_KEY;
  const SK = process.env.NAVER_SECRET_KEY;

  function hdr(m, uri) {
    const ts = Date.now().toString();
    return { 'X-Timestamp': ts, 'X-API-KEY': AK, 'X-CUSTOMER': String(CID),
      'X-Signature': crypto.createHmac('sha256', SK).update(`${ts}.${m}.${uri}`).digest('base64'),
      'Content-Type': 'application/json' };
  }
  async function call(uri, qs) {
    const r = await fetch(BASE + uri + (qs ? '?' + qs : ''), { headers: hdr('GET', uri) });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 300); }
    return { status: r.status, body: b };
  }

  const list = await call('/stat-reports');
  const out = {};
  if (!Array.isArray(list.body)) return res.status(200).json({ list });

  for (const item of list.body.filter(x => x.status === 'BUILT')) {
    const d = await call(`/stat-reports/${item.reportJobId}`);
    const url = d.body && d.body.downloadUrl;
    if (!url) continue;
    const fr = await fetch(url, { headers: hdr('GET', '/report-download') });
    const txt = await fr.text();
    const rows = txt.split('\n').filter(Boolean).map(l => l.split('\t'));
    if (!rows.length) continue;

    const n = rows[0].length;
    const sums = [];
    for (let i = 0; i < n; i++) {
      const vals = rows.map(r => Number(r[i]));
      const allNum = vals.every(v => !isNaN(v));
      sums.push(allNum ? vals.reduce((a, b) => a + b, 0) : '(문자)');
    }
    out[item.reportTp] = {
      columns: n,
      rows: rows.length,
      column_sums: sums,
      sample_rows: rows.slice(0, 2)
    };
  }

  return res.status(200).json(out);
}
