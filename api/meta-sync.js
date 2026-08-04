// api/meta-sync.js — 메타 광고 데이터 자동 동기화
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
  const days = Math.min(parseInt(q.days || '7', 10), 30);

  const today = new Date();
  const until = today.toISOString().slice(0, 10);
  const sinceD = new Date(today.getTime() - (days - 1) * 864e5);
  const since = sinceD.toISOString().slice(0, 10);

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
    for (let i = 0; i < 10 && url; i++) {
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'Graph API 오류');
      out = out.concat(j.data || []);
      url = j.paging && j.paging.next ? j.paging.next : null;
    }
    return out;
  }

  const FIELDS = 'date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,action_values';
  const results = [];

  for (const acc of accounts) {
    const log = { act_id: acc.act_id, account_name: acc.account_name, date_from: since, date_to: until, status: 'running', rows_upserted: 0 };
    try {
      const dailyUrl = `https://graph.facebook.com/${V}/${acc.act_id}/insights?level=ad&time_range={"since":"${since}","until":"${until}"}&time_increment=1&fields=${FIELDS}&limit=200&access_token=${TOKEN}`;
      const daily = await fetchAll(dailyUrl);

      const rows = daily.map(d => {
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

      const del = await fetch(`${SB}/rest/v1/meta_ad_data?act_id=eq.${encodeURIComponent(acc.act_id)}&date=gte.${since}&date=lte.${until}&source=eq.api`, { method: 'DELETE', headers: sbHeaders });
      if (!del.ok) throw new Error('기존 데이터 삭제 실패: ' + await del.text());
      for (let i = 0; i < rows.length; i += 500) {
        const ins = await fetch(`${SB}/rest/v1/meta_ad_data`, { method: 'POST', headers: { ...sbHeaders, 'Prefer': 'return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
        if (!ins.ok) throw new Error('삽입 실패: ' + await ins.text());
      }
      log.rows_upserted = rows.length;

      const rollUrl = `https://graph.facebook.com/${V}/${acc.act_id}/insights?level=ad&time_range={"since":"${since}","until":"${until}"}&fields=${FIELDS}&limit=200&access_token=${TOKEN}`;
      const roll = await fetchAll(rollUrl);
      const rollRows = roll.map(d => {
        const { purchases, purchaseValue } = flatten(d);
        return {
          client_key: acc.account_name, act_id: acc.act_id, date_from: since, date_to: until,
          ad_id: d.ad_id, ad_name: d.ad_name || null,
          campaign_name: d.campaign_name || null, adset_name: d.adset_name || null,
          spend: Number(d.spend) || 0, impressions: Number(d.impressions) || 0,
          reach: Number(d.reach) || 0, frequency: Number(d.frequency) || null,
          purchases, purchase_value: purchaseValue, raw: d
        };
      });
      if (rollRows.length) {
        await fetch(`${SB}/rest/v1/meta_ad_rollup?on_conflict=act_id,date_from,date_to,ad_id`, { method: 'POST', headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rollRows) });
      }

      log.status = 'success';
    } catch (e) {
      log.status = 'error';
      log.error_message = String(e.message || e).slice(0, 500);
    }
    log.finished_at = new Date().toISOString();
    try {
      await fetch(`${SB}/rest/v1/meta_sync_log`, { method: 'POST', headers: { ...sbHeaders, 'Prefer': 'return=minimal' }, body: JSON.stringify(log) });
    } catch (e) {}
    results.push({ account: acc.account_name, status: log.status, rows: log.rows_upserted, error: log.error_message || null });
  }

  return res.status(200).json({ done: true, since, until, results });
}
