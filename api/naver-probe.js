// api/naver-probe.js — 완성된 대용량 보고서 내려받아 컬럼 확인
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
    let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 400); }
    return { status: r.status, body: b };
  }
  async function post(uri, payload) {
    const r = await fetch(BASE + uri, { method: 'POST', headers: hdr('POST', uri), body: JSON.stringify(payload) });
    const t = await r.text();
    let b; try { b = JSON.parse(t); } catch (e) { b = t.slice(0, 300); }
    return { status: r.status, body: b };
  }

  const out = {};
  const statDt = (q.date || '2026-08-05') + 'T00:00:00.000Z';

  // 필요하면 새로 생성
  if (q.make === '1') {
    out.made = {};
    for (const tp of ['AD_DETAIL','EXPKEYWORD','AD','AD_CONVERSION']) {
      const r = await post('/stat-reports', { reportTp: tp, statDt });
      out.made[tp] = { status: r.status, id: r.body && r.body.reportJobId };
    }
  }

  // 목록 확인
  const list = await call('/stat-reports');
  out.list = Array.isArray(list.body)
    ? list.body.map(x => ({ tp: x.reportTp, st: x.status, id: x.reportJobId, url: x.downloadUrl ? '있음' : '없음' }))
    : list.body;

  // BUILT 상태인 것들의 상세 정보와 실제 내용
  out.detail = {};
  if (Array.isArray(list.body)) {
    for (const item of list.body.filter(x => x.status === 'BUILT').slice(0, 3)) {
      const d = await call(`/stat-reports/${item.reportJobId}`);
      const info = { tp: item.reportTp, status: d.status, keys: d.body && typeof d.body === 'object' ? Object.keys(d.body) : null };
      const url = d.body && (d.body.downloadUrl || d.body.downloadURL);
      if (url) {
        try {
          const uri = '/report-download';
          const fr = await fetch(url, { headers: hdr('GET', uri) });
          const txt = await fr.text();
          const lines = txt.split('\n').filter(Boolean);
          info.download_status = fr.status;
          info.total_lines = lines.length;
          info.first_lines = lines.slice(0, 3);
        } catch (e) { info.download_err = String(e.message); }
      } else {
        info.body = d.body;
      }
      out.detail[item.reportTp] = info;
    }
  }

  return res.status(200).json(out);
}
