// מסלול 12 — sends the morning / evening push. Run by .github/workflows/push.yml
// The plan data is read from index.html itself, so there is one source of truth.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const webpush = require('web-push');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// --- load the plan code from index.html ---
const a = html.indexOf('/* ================= helpers');
const b = html.indexOf('/* ================= storage');
const i = html.indexOf('/*ICS-START*/');
const j = html.indexOf('/*ICS-END*/');
if ([a, b, i, j].some((x) => x < 0)) throw new Error('Plan code markers not found in index.html');
const ctx = vm.createContext({ TextEncoder, console, window: {}, location: { protocol: 'file:' } });
const P = vm.runInContext(html.slice(a, b) + html.slice(i, j) + ';({baseDay,DAYS,diffDays})', ctx);

// --- today in Israel ---
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

// --- subscriptions + keys ---
let subs = [];
try {
  const raw = JSON.parse(process.env.PUSH_SUBSCRIPTIONS || '[]');
  subs = Array.isArray(raw) ? raw : [raw];
} catch (err) {
  console.error('PUSH_SUBSCRIPTIONS is not valid JSON. Copy it again from the app (gear → העתק קוד מכשיר).');
  process.exit(1);
}
if (!subs.length) {
  console.error('No device yet. In the app: gear → הפעל התראות → העתק קוד מכשיר, then save it as the PUSH_SUBSCRIPTIONS secret.');
  process.exit(1);
}
const pubMatch = html.match(/const VAPID_PUBLIC='([^']+)'/);
const publicKey = process.env.VAPID_PUBLIC || (pubMatch && pubMatch[1]);
const privateKey = process.env.VAPID_PRIVATE;
if (!publicKey || !privateKey) {
  console.error('Missing VAPID_PRIVATE secret (see README).');
  process.exit(1);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://github.com', publicKey, privateKey);

(async () => {
  let ok = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 4 * 3600, urgency: 'high' });
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.error('A device is no longer subscribed. Enable notifications again in the app and update PUSH_SUBSCRIPTIONS.');
      } else {
        console.error('Send failed:', err.statusCode || '', err.body || err.message);
      }
    }
  }
  console.log(`${today} ${type}: sent to ${ok}/${subs.length} device(s). "${payload.title}"`);
  if (!ok) process.exit(1);
})();
