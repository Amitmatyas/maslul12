const fs = require('fs');
const path = require('path');
const vm = require('vm');
const webpush = require('web-push');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const a = html.indexOf('const $=(s,r=document)');
const b = html.indexOf("const KEY='maslul12:v1'");
if ([a, b].some((x) => x < 0)) throw new Error('Plan code markers not found in index.html');
const ctx = vm.createContext({ TextEncoder, console, window: {}, location: { protocol: 'file:' } });
const P = vm.runInContext(html.slice(a, b) + ';({baseDay,DAYS,diffDays})', ctx);

const tz = cfg.timezone || 'Asia/Jerusalem';
const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
const get = (t) => parts.find((p) => p.type === t).value;
const today = `${get('year')}-${get('month')}-${get('day')}`;
const hour = Number(get('hour'));

let type = (process.env.PUSH_TYPE || '').trim();
if (!type) {
  const s = process.env.SCHEDULE || '';
  type = s === cfg.morningCron ? 'morning' : s === cfg.eveningCron ? 'evening' : hour < 12 ? 'morning' : 'evening';
}

const n = P.diffDays(cfg.start, today);
if (type !== 'test' && (n < 0 || n >= 84)) {
  console.log(`${today}: outside the 12-week plan (starts ${cfg.start}). Nothing sent.`);
  process.exit(0);
}
const dayN = Math.min(83, Math.max(0, n));
const week = Math.floor(dayN / 7) + 1;
const dow = dayN % 7;
const base = P.baseDay(week, dow);

const payload = {
  type: type === 'test' ? 'morning' : type,
  date: type === 'test' ? undefined : today,
  title: base.t,
  body: `שבוע ${week}/12 · ${base.d}`
};

const SB_URL = 'https://oboxnalkzusytnwrcstr.supabase.co/rest/v1/rpc/';
const SB_KEY = (html.match(/SB_KEY='([^']+)'/) || [])[1];
const rpc = (fn, body) => fetch(SB_URL + fn, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const pubMatch = html.match(/const VAPID_PUBLIC='([^']+)'/);
const publicKey = process.env.VAPID_PUBLIC || (pubMatch && pubMatch[1]);
const privateKey = process.env.VAPID_PRIVATE;
if (!publicKey || !privateKey) {
  console.error('Missing VAPID_PRIVATE secret (see README).');
  process.exit(1);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com', publicKey, privateKey);

(async () => {
  const subs = [];
  const seen = new Set();
  const add = (x) => { if (x && x.endpoint && !seen.has(x.endpoint)) { seen.add(x.endpoint); subs.push(x); } };
  if (process.env.PUSH_TOKEN) {
    const r = await rpc('push_list', { t: process.env.PUSH_TOKEN });
    if (r.ok) (await r.json()).forEach(add);
    else console.error('Device list failed:', r.status, await r.text());
  }
  try { [].concat(JSON.parse(process.env.PUSH_SUBSCRIPTIONS || '[]')).forEach(add); } catch (err) {}
  if (!subs.length) {
    console.error('No devices yet. Turn on notifications in the app.');
    process.exit(1);
  }
  let ok = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 4 * 3600, urgency: 'high' });
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.error('Removed an expired device.');
        if (process.env.PUSH_TOKEN) await rpc('push_drop', { t: process.env.PUSH_TOKEN, ep: sub.endpoint });
      } else {
        console.error('Send failed:', err.statusCode || '', err.body || err.message);
      }
    }
  }
  console.log(`${today} ${type}: sent to ${ok}/${subs.length} device(s). "${payload.title}"`);
  if (!ok) process.exit(1);
})();
