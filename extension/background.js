/* ── Ticketdash Monitor — background.js ── */

const ALARM_NAME = 'ticketdash-check';
const ALARM_PERIOD = 1; // minutes

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await checkTickets();
});

async function checkTickets() {
  const { serverUrl, notifiedKeys } = await chrome.storage.local.get(['serverUrl', 'notifiedKeys']);
  const base = (serverUrl || 'https://ticketmastersrhunter360.milcoms.org').replace(/\/$/, '');
  const alreadyNotified = new Set(notifiedKeys || []);

  let area, tickets;
  try {
    const me = await fetch(`${base}/auth/me`, { credentials: 'include' }).then(r => r.json());
    if (!me.authenticated) return;
    const groups = me.user?.groups || [];
    const isSM    = groups.some(g => ['sm-users','sm-leads','managers','authentik Admins'].includes(g));
    const isMerge = groups.some(g => ['merge-users','merge-leads','managers','authentik Admins'].includes(g));
    if (!isSM && !isMerge) return;
    area = isSM ? 'sm' : 'merge';

    const shift = await fetch(`${base}/api/${area}/shifts/today`, { credentials: 'include' }).then(r => r.json());
    const data  = await fetch(`${base}/api/${area}/shifts/${shift.id}/tickets`, { credentials: 'include' }).then(r => r.json());
    tickets = data || [];
  } catch {
    return;
  }

  const newKeys = [];

  for (const t of tickets) {
    checkDate(t.id, 'PS', t.prepStart, alreadyNotified, newKeys, base);
    checkDate(t.id, 'ES', t.execStart, alreadyNotified, newKeys, base);
  }

  // Persist which notifications we've already fired
  await chrome.storage.local.set({ notifiedKeys: newKeys });
}

function checkDate(ticketId, label, iso, alreadyNotified, newKeys, base) {
  if (!iso) return;
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d)) return;
  const min = (d.getTime() - Date.now()) / 60000;

  // Notify once per ticket+label when entering warn zone (≤15 min) or near zone (≤5 min)
  const key15 = `${ticketId}-${label}-15`;
  const key5  = `${ticketId}-${label}-5`;
  const key0  = `${ticketId}-${label}-0`;

  // Keep keys that are still future so we don't re-fire them
  if (min > 0) {
    if (min <= 15 && !alreadyNotified.has(key15)) {
      const mStr = Math.ceil(min);
      chrome.notifications.create(`${ticketId}-${label}-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon48.png',
        title: `${label} in ~${mStr} min — ${ticketId}`,
        message: `Ticket ${ticketId}: ${label} starts at ${fmtTime(d)}`,
        priority: min <= 5 ? 2 : 1,
      });
      newKeys.push(key15);
    } else if (alreadyNotified.has(key15)) {
      newKeys.push(key15); // still valid, keep it
    }

    if (min <= 5 && !alreadyNotified.has(key5)) {
      chrome.notifications.create(`${ticketId}-${label}-near-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icon48.png',
        title: `⚠️ ${label} in ${Math.ceil(min)} min — ${ticketId}`,
        message: `Ticket ${ticketId}: ${label} starts at ${fmtTime(d)}`,
        priority: 2,
      });
      newKeys.push(key5);
    } else if (alreadyNotified.has(key5)) {
      newKeys.push(key5);
    }
  }

  // Active window: 0 to 45 min past
  if (min <= 0 && min >= -45 && !alreadyNotified.has(key0)) {
    chrome.notifications.create(`${ticketId}-${label}-started-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: `🔴 ${label} started — ${ticketId}`,
      message: `Ticket ${ticketId}: ${label} was ${fmtTime(d)}`,
      priority: 2,
    });
    newKeys.push(key0);
  } else if (alreadyNotified.has(key0)) {
    // Expire after active window
    if (min >= -45) newKeys.push(key0);
  }
}

function fmtTime(d) {
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${hh}:${mm} UTC`;
}
