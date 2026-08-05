// api/meta-sync.js — 메타 광고 데이터 자동 동기화 + 과거 백필
//
// [사용법]
//  매일 크론                : /api/meta-sync?all=1&days=14
//  전체 기간 싹 다          : /api/meta-sync?secret=XXX&alltime=1
//     └ done:true 가 나올 때까지 같은 주소를 반복 호출하면 이어서 진행됩니다.
//  한 달만                  : /api/meta-sync?secret=XXX&month=2026-05
//  여러 달                  : /api/meta-sync?secret=XXX&from=2026-01&to=2026-05
//  특정 계정만              : ...&account=act_869721212821467
//  이미 받은 달도 다시      : ...&force=1

export default async function handler(req, res) {
  const q = req.query || {};
  const okSecret = q.secret === process.env.CRON_SECRET
    || (req.headers['authorization'] === 'Bearer ' + process.env.CRON_SECRET);
  if (!okSecret) return res.status(401).json({ error: 'unauthorized' });

  const V = process.env.META_API_VERSION || 'v25.0';
  const TOKEN = process.env.META_ACCESS_TOKEN;
  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  const t0 = Date.now();
  const BUDGET_MS = Math.min(Math.max(parseInt(q.budget || '45', 10), 10), 280) * 1000;
  const WANT_ROLLUP = q.rollup !== '0';
  const PAUSE_MS = Math.min(Math.max(parseInt(q.pause || '1500', 10), 0), 10000);
  const FORCE = q.force === '1';

  const iso = d => d.toISOString().slice(0, 10);
  const TODAY = iso(new Date());
  const MIN_DATE = '2022-01-01';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isRateLimit = m => /blocked|rate limit|too many|reduce the amount|user request limit/i.test(String(m || ''));

  function monthChunk(m) {
    const [y, mo] = String(m).split('-').map(Number);
    if (!y || !mo || mo < 1 || mo > 12) return null;
    return {
      label: `${y}-${String(mo).padStart(2, '0')}`,
      since: iso(new Date(Date.UTC(y, mo - 1, 1))),
      until: iso(new Date(Date.UTC(y, mo, 0)))
    };
  }

  function monthRange(a, b) {
    if (!monthChunk(a) || !monthChunk(b)) return [];
    const out = [];
    let [y, m] = a.split('-').map(Number);
    const [ey, em] = b.split('-').map(Number);
    for (let i = 0; i < 60; i++) {
      if (y > ey || (y === ey && m > em)) break;
      const c = monthChunk(`${y}-${String(m).padStart(2, '0')}`);
      if (c) out.push(c);
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  function monthsAgo(n) {
    const d = new Date();
    return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1))).slice(0, 7);
  }

  const clampChunk = c => ({ ...c, since: c.since < MIN_DATE ? MIN_DATE : c.since, until: c.until > TODAY ? TODAY : c.until });

  let chunks = [];
  let mode = 'daily';

  if (q.alltime === '1') {
    mode = 'alltime';
  } else if (q.month) {
    mode = 'backfill';
    const c = monthChunk(q.month);
    if (!c) return res.status(400).json({ error: 'month 형식 오류 (예: 2026-05)' });
    chunks = [c];
  } else if (q.from && q.to) {
    mode = 'backfill';
    chunks = monthRange(q.from, q.to);
    if (!chunks.length) return res.status(400).json({ error: 'from/to 형식 오류 (예: from=2026-01&to=2026-05)' });
  } else if (q.since && q.until) {
    mode = 'backfill';
    chunks = [{ label: `${q.since}~${q.until}`, since: q.since, until: q.until }];
  } else {
    const days = Math.min(Math.max(parseInt(q.days || '7', 10), 1), 92);
    const d = new Date();
    chunks = [{ label: `최근 ${days}일`, since: iso(new Date(d.getTime() - (days - 1) * 864e5)), until: TODAY }];
  }

  if (mode !== 'alltime') {
    chunks = chunks.map(clampChunk).filter(c => c.since <= c.until);
    if (!chunks.length) return res.status(200).json({ done: true, message: '처리할 기간 없음' });
  }

  let accounts = [];
  try {
    let url = `${SB}/rest/v1/meta_ad_accounts?is_active=eq.true&select=account_name,act_id`;
    if (q.account) url += `&act_id=eq.${encodeURIComponent(q.account)}`;
    const r = await fetch(url, { headers: sbHeaders });
    accounts = await r.json();
  } catch (e) {
    return res.status(500).json({ error: '계정 목록 조회 실패: ' + e.message });
  }
  if (!Array.isArray(accounts) || !accounts.length) {
    return res.status(200).json({ done: true, message: '동기화할 계정 없음' });
  }

  function flatten(row) {
    const flat = {};
    (row.actions || []).forEach(a => { flat['action_' + a.action_type] = Number(a.value) || 0; });
    (row.action_values || []).forEach(a => { flat['value_' + a.action_type] = Number(a.value) || 0; });
    const purchases = flat['action_purchase'] ?? flat['action_offsite_conversion.fb_pixel_purchase'] ?? 0;
    const purchaseValue = flat['value_purchase'] ?? flat['value_offsite_conversion.fb_pixel_purchase'] ?? 0;
    const leads = flat['action_lead'] ?? flat['action_offsite_conversion.fb_pixel_lead'] ?? 0;
    return { flat, purchases, purchaseValue, leads };
  }

  async function fetchAll(firstUrl) {
    let url = firstUrl, out = [];
    for (let i = 0; i < 40 && url; i++) {
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'Graph API 오류');
      out = out.concat(j.data || []);
      url = j.paging && j.paging.next ? j.paging.next : null;
    }
    return out;
  }

  const FIELDS = 'date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,action_values';

  async function accountMonths(acc) {
    let start = null;
    try {
      const r = await fetch(`https://graph.facebook.com/${V}/${acc.act_id}?fields=created_time&access_token=${TOKEN}`);
      const j = await r.json();
      if (j && j.created_time) start = String(j.created_time).slice(0, 7);
    } catch (e) {}
    const floor = monthsAgo(36);
    if (!start || start < floor) start = floor;
    if (q.from && q.from > start) start = q.from;
    return monthRange(start, TODAY.slice(0, 7)).map(clampChunk).filter(c => c.since <= c.until);
  }

  async function syncOne(acc, ch) {
    const log = {
      act_id: acc.act_id, account_name: acc.account_name,
      date_from: ch.since, date_to: ch.until,
      status: 'running', rows_upserted: 0
    };
    try {
      const dailyUrl = `https://graph.facebook.com/${V}/${acc.act_id}/insights?level=ad&time_range={"since":"${ch.since}","until":"${ch.until}"}&time_increment=1&fields=${FIELDS}&limit=500&access_token=${TOKEN}`;
      const daily = await fetchAll(dailyUrl);

      const rows = daily.filter(d => d.ad_id && d.date_start).map(d => {
        const { flat, purchases, purchaseValue, leads } = flatten(d);
        const spend = Number(d.spend) || 0;
        return {
          client_key: acc.account_name, act_id: acc.act_id, date: d.date_start,
          campaign_id: d.campaign_id || null, campaign_name: d.campaign_name || null,
          adset_id: d.adset_id || null, adset_name: d.adset_name || null,
          ad_id: d.ad_id, ad_name: d.ad_name || null,
          spend, impressions: Number(d.impressions) || 0,
          reach: Number(d.reach) || 0, frequency: Number(d.frequency) || null,
          clicks: Number(d.clicks) || 0, ctr: Number(d.ctr) || null,
          cpc: Number(d.cpc) || null, cpm: Number(d.cpm) || null,
          purchases, purchase_value: purchaseValue, leads,
          roas: spend > 0 ? +(purchaseValue / spend).toFixed(4) : null,
          source: 'api', raw: { ...d, _flat: flat }
        };
      });

      const del = await fetch(`${SB}/rest/v1/meta_ad_data?act_id=eq.${encodeURIComponent(acc.act_id)}&date=gte.${ch.since}&date=lte.${ch.until}&source=eq.api`, { method: 'DELETE', headers: sbHeaders });
      if (!del.ok) throw new Error('기존 데이터 삭제 실패: ' + await del.text());

      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${SB}/rest/v1/meta_ad_data`, { method: 'POST', headers: { ...sbHeaders, 'Prefer': 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!ins.ok) throw new Error('삽입 실패: ' + await ins.text());
      }
      log.rows_upserted = rows.length;

      if (WANT_ROLLUP) {
        const rollUrl = `https://graph.facebook.com/${V}/${acc.act_id}/insights?level=ad&time_range={"since":"${ch.since}","until":"${ch.until}"}&fields=${FIELDS}&limit=500&access_token=${TOKEN}`;
        const roll = await fetchAll(rollUrl);
        const rollRows = roll.filter(d => d.ad_id).map(d => {
          const { purchases, purchaseValue } = flatten(d);
          return {
            client_key: acc.account_name, act_id: acc.act_id,
            date_from: ch.since, date_to: ch.until,
            ad_id: d.ad_id, ad_name: d.ad_name || null,
            campaign_name: d.campaign_name || null, adset_name: d.adset_name || null,
            spend: Number(d.spend) || 0, impressions: Number(d.impressions) || 0,
            reach: Number(d.reach) || 0, frequency: Number(d.frequency) || null,
            purchases, purchase_value: purchaseValue, raw: d
          };
        });
        for (let i = 0; i < rollRows.length; i += 500) {
          await fetch(`${SB}/rest/v1/meta_ad_rollup?on_conflict=act_id,date_from,date_to,ad_id`, { method: 'POST', headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rollRows.slice(i, i + 500)) });
        }
        log.rollup_rows = rollRows.length;
      }

      log.status = 'success';
    } catch (e) {
      log.status = 'error';
      log.error_message = String(e.message || e).slice(0, 500);
    }
    log.finished_at = new Date().toISOString();
    try {
      const { rollup_rows, ...logRow } = log;
      await fetch(`${SB}/rest/v1/meta_sync_log`, { method: 'POST', headers: { ...sbHeaders, 'Prefer': 'return=minimal' }, body: JSON.stringify(logRow) });
    } catch (e) {}
    return log;
  }

  let tasks = [];
  if (mode === 'alltime') {
    for (const acc of accounts) {
      const ms = await accountMonths(acc);
      ms.reverse();
      for (const c of ms) tasks.push({ ch: c, acc });
    }
  } else {
    for (const ch of chunks) for (const acc of accounts) tasks.push({ ch, acc });
  }

  const totalTasks = tasks.length;

  let skipped = 0;
  if (mode === 'alltime' && !FORCE) {
    try {
      const r = await fetch(`${SB}/rest/v1/meta_sync_log?status=eq.success&select=act_id,date_from,date_to&limit=5000`, { headers: sbHeaders });
      const logs = await r.json();
      if (Array.isArray(logs)) {
        const doneSet = new Set(logs.map(l => `${l.act_id}|${l.date_from}|${l.date_to}`));
        const before = tasks.length;
        tasks = tasks.filter(t => !doneSet.has(`${t.acc.act_id}|${t.ch.since}|${t.ch.until}`));
        skipped = before - tasks.length;
      }
    } catch (e) {}
  }

  const results = [];
  let doneCount = 0;
  let stoppedByRateLimit = false;

  for (const t of tasks) {
    if (doneCount > 0 && Date.now() - t0 > BUDGET_MS) break;
    if (doneCount > 0 && PAUSE_MS) await sleep(PAUSE_MS);

    const log = await syncOne(t.acc, t.ch);
    results.push({
      period: t.ch.label, account: t.acc.account_name,
      status: log.status, rows: log.rows_upserted,
      rollup: log.rollup_rows ?? null, error: log.error_message || null
    });
    doneCount++;

    if (log.status === 'error' && isRateLimit(log.error_message)) {
      stoppedByRateLimit = true;
      break;
    }
  }

  const remaining = tasks.slice(doneCount);
  const out = {
    done: remaining.length === 0 && !stoppedByRateLimit,
    mode,
    accounts: accounts.length,
    total_periods: totalTasks,
    already_done: skipped,
    processed: doneCount,
    remaining: remaining.length,
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
    results
  };

  if (stoppedByRateLimit) {
    out.message = '메타 요청량 제한에 걸려 중단했습니다. 15~30분 뒤 같은 주소를 다시 호출하세요. 처리한 구간까지는 저장되었습니다.';
  } else if (remaining.length) {
    out.message = mode === 'alltime'
      ? `${doneCount}건 저장했습니다. 같은 주소를 다시 호출하면 남은 ${remaining.length}건을 이어서 받습니다.`
      : `시간이 부족해 ${doneCount}건까지 저장했습니다. 아래 next를 다시 호출하세요.`;
    const leftMonths = [...new Set(remaining.map(r => r.ch.label))];
    out.remaining_periods = leftMonths.slice(0, 12);
    if (mode !== 'alltime') {
      out.next = leftMonths.length > 1
        ? `/api/meta-sync?secret=YOUR_SECRET&from=${leftMonths[leftMonths.length - 1]}&to=${leftMonths[0]}`
        : `/api/meta-sync?secret=YOUR_SECRET&month=${leftMonths[0]}`;
    }
  } else if (mode === 'alltime') {
    out.message = `전체 기간 수집 완료 (총 ${totalTasks}구간, 이번 실행 ${doneCount}건).`;
  }

  return res.status(200).json(out);
}
