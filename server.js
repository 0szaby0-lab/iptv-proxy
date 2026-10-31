// Node.js — IPTV auto-registration service for render.com
// submits WPForms free trial form every 20 hours with a fresh SimpleLogin alias + Gmail IMAP

const express = require('express');
const cron = require('node-cron');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

// in-memory log buffer for /logs endpoint
const runtimeLogs = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  runtimeLogs.push(line);
  if (runtimeLogs.length > 500) runtimeLogs.shift();
  origLog(...args);
};
console.error = (...args) => {
  const line = `[${new Date().toISOString()}] [ERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  runtimeLogs.push(line);
  if (runtimeLogs.length > 500) runtimeLogs.shift();
  origErr(...args);
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// log all incoming HTTP requests
app.use((req, res, next) => {
  if (req.path !== '/logs') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} from ${ip} (UA: ${req.headers['user-agent'] || 'none'})`);
  }
  next();
});

// ─── config ───────────────────────────────────────────────────────
const TARGET_URL = 'https://iptvload.org/iptv-free-trial-4/';
const REGISTER_INTERVAL_HOURS = 20;

// SimpleLogin & Gmail IMAP configuration
const SIMPLELOGIN_API = process.env.SIMPLELOGIN_API || 'https://app.simplelogin.io';
const SIMPLELOGIN_API_KEY = process.env.SIMPLELOGIN_API_KEY;

const IMAP_CONFIG = {
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: parseInt(process.env.IMAP_PORT, 10) || 993,
  secure: true,
  auth: {
    user: process.env.IMAP_USER,
    pass: process.env.IMAP_PASS
  },
  logger: false
};

// random data pools
const FIRST_NAMES = [
  'James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph',
  'Thomas', 'Christopher', 'Charles', 'Daniel', 'Matthew', 'Anthony', 'Mark',
  'Steven', 'Paul', 'Andrew', 'Joshua', 'Kenneth', 'Kevin', 'Brian', 'George',
  'Timothy', 'Ronald', 'Edward', 'Jason', 'Jeffrey', 'Ryan', 'Jacob',
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan',
  'Jessica', 'Sarah', 'Karen', 'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra',
  'Ashley', 'Dorothy', 'Kimberly', 'Emily', 'Donna', 'Michelle', 'Carol',
  'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson'
];

const COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Germany', 'France',
  'Netherlands', 'Australia', 'Sweden', 'Denmark', 'Norway',
  'Belgium', 'Switzerland', 'Austria', 'Ireland', 'Finland',
  'Spain', 'Italy', 'Portugal', 'Greece', 'Poland',
  'Romania', 'Czechia', 'Hungary', 'Brazil', 'Mexico'
];

// exact values from WPForms field 5 select options
const DEVICES = ['Android Box', 'Smart TV', 'Fire Tv Stick', 'Apple TV', 'Nvidia Shield', 'Formuler'];
// exact values from WPForms field 9 select options (Xtream Codes apps only)
const APPS = ['Iptv Smarters Pro', 'Tivimate', 'Kodi', 'OTT Player', 'GSE Smart IPTV'];

// ─── helpers ──────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...options.headers
      }
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      // handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        return resolve(httpRequest(redirectUrl, options));
      }
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, cookies: res.headers['set-cookie'] || [] }));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── temp email (Emailnator API + Gmail IMAP fallback) ───────────

async function generateEmailnatorAccount() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[*] Emailnator GoogleMail generation attempt ${attempt}/5...`);
      const res = await httpRequest('https://www.emailnator.com/api/generate-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://www.emailnator.com',
          'Referer': 'https://www.emailnator.com/'
        },
        body: JSON.stringify({ ids: [8] })
      });

      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.status === 'success' && data.email) {
          console.log(`[+] Emailnator GoogleMail generated: ${data.email}`);
          return {
            provider: 'emailnator',
            address: data.email,
            createdAt: Date.now(),
            createdAtSeconds: Math.floor(Date.now() / 1000)
          };
        }
      }
      console.log(`[-] Emailnator HTTP ${res.status}: ${res.body.substring(0, 100)}`);
    } catch (err) {
      console.log(`[-] Emailnator attempt ${attempt} error: ${err.message}`);
    }
    await sleep(2500 * attempt);
  }
  return null;
}

async function checkEmailnatorInbox(account) {
  try {
    const res = await httpRequest('https://www.emailnator.com/api/message-list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.emailnator.com',
        'Referer': 'https://www.emailnator.com/'
      },
      body: JSON.stringify({ email: account.address, limit: 25 })
    });

    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const messages = (data.messages || []).filter(m => {
        return !account.createdAtSeconds || (m.timestamp >= account.createdAtSeconds - 120);
      });
      return messages.map(m => ({
        id: m.id,
        from: m.from || '',
        subject: m.subject || '',
        timestamp: m.timestamp,
        timeAgo: m.time_ago
      }));
    }
  } catch (err) {
    console.log(`[-] Emailnator checkInbox error: ${err.message}`);
  }
  return [];
}

async function readEmailnatorMessage(msgId) {
  try {
    const res = await httpRequest(`https://www.emailnator.com/api/message/${encodeURIComponent(msgId)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.emailnator.com',
        'Referer': 'https://www.emailnator.com/'
      }
    });

    if (res.status === 200) {
      const data = JSON.parse(res.body);
      return {
        from: data.from || '',
        subject: data.subject || '',
        body: data.content || ''
      };
    }
  } catch (err) {
    console.log(`[-] Emailnator readMessage error: ${err.message}`);
  }
  return { from: '', subject: '', body: '' };
}

async function createTempMailAccount() {
  const emailnatorAcc = await generateEmailnatorAccount();
  if (emailnatorAcc) return emailnatorAcc;

  console.log(`[*] Emailnator unavailable, attempting SimpleLogin fallback...`);
  await cleanupOldSimpleLoginAliases();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[*] SimpleLogin alias attempt ${attempt}/3...`);
      const res = await httpRequest(`${SIMPLELOGIN_API}/api/alias/random/new`, {
        method: 'POST',
        headers: {
          'Authentication': SIMPLELOGIN_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`SimpleLogin HTTP ${res.status}: ${res.body.substring(0, 150)}`);
      }

      const data = JSON.parse(res.body);
      const aliasAddress = data.email || data.alias;
      console.log(`[+] SimpleLogin success: ${aliasAddress} (ID: ${data.id})`);

      return {
        provider: 'simplelogin',
        address: aliasAddress,
        aliasId: data.id,
        createdAt: new Date(Date.now() - 120000)
      };
    } catch (err) {
      console.log(`[-] SimpleLogin attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await sleep(3000 * attempt);
    }
  }

  // Final fallback to Gmail IMAP alias
  const userBase = (IMAP_CONFIG.auth.user || '').replace(/@gmail\.com$/i, '');
  const gmailAlias = `${userBase}+tv${randInt(10000, 99999)}@gmail.com`;
  console.log(`[*] Using Gmail alias fallback: ${gmailAlias}`);
  return {
    provider: 'gmail_imap',
    address: gmailAlias,
    createdAt: new Date(Date.now() - 60000)
  };
}

async function deleteTempMailAccount(account) {
  if (!account || !account.aliasId || account.provider !== 'simplelogin') return;
  try {
    const res = await httpRequest(`${SIMPLELOGIN_API}/api/aliases/${account.aliasId}`, {
      method: 'DELETE',
      headers: {
        'Authentication': SIMPLELOGIN_API_KEY
      }
    });
    if (res.status === 200) {
      console.log(`[+] SimpleLogin alias deleted: ${account.address} (ID: ${account.aliasId})`);
    } else {
      console.log(`[-] SimpleLogin delete status ${res.status}: ${res.body}`);
    }
  } catch (err) {
    console.log(`[-] SimpleLogin delete error: ${err.message}`);
  }
}

async function checkInbox(account) {
  if (account && account.provider === 'emailnator') {
    return await checkEmailnatorInbox(account);
  }

  const client = new ImapFlow(IMAP_CONFIG);
  const messages = [];

  try {
    await client.connect();
    const boxes = ['[Gmail]/Spam', 'INBOX'];
    for (const box of boxes) {
      try {
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await client.search({ all: true }, { uid: true });
          if (uids && uids.length > 0) {
            const recentUids = uids.slice(-15).reverse();
            for await (const msg of client.fetch(recentUids, { uid: true, envelope: true })) {
              const subject = msg.envelope.subject || '';
              const from = msg.envelope.from?.[0]?.address || '';

              const msgDate = msg.envelope.date ? new Date(msg.envelope.date).getTime() : Date.now();
              const accountCreated = account.createdAt ? new Date(account.createdAt).getTime() : 0;
              if (msgDate >= accountCreated - 60000) {
                messages.push({
                  id: msg.uid,
                  mailbox: box,
                  from: from,
                  subject: subject,
                  date: msg.envelope.date
                });
              }
            }
          }
        } finally {
          lock.release();
        }
      } catch (boxErr) {
        console.log(`[-] error checking mailbox ${box}: ${boxErr.message}`);
      }
    }
    await client.logout();
  } catch (err) {
    console.log(`[-] IMAP checkInbox error: ${err.message}`);
  }

  return messages;
}

async function readMessage(account, msgRef) {
  if (account && account.provider === 'emailnator') {
    const msgId = typeof msgRef === 'object' ? msgRef.id : msgRef;
    return await readEmailnatorMessage(msgId);
  }

  const client = new ImapFlow(IMAP_CONFIG);
  let result = { from: '', subject: '', body: '' };

  const msgUid = typeof msgRef === 'object' ? msgRef.id : msgRef;
  const preferredBox = (typeof msgRef === 'object' && msgRef.mailbox) ? msgRef.mailbox : '[Gmail]/Spam';
  const boxes = [preferredBox, preferredBox === 'INBOX' ? '[Gmail]/Spam' : 'INBOX'];

  try {
    await client.connect();
    for (const box of boxes) {
      try {
        const lock = await client.getMailboxLock(box);
        try {
          const msg = await client.fetchOne(String(msgUid), { source: true }, { uid: true });
          if (msg && msg.source) {
            const parsed = await simpleParser(msg.source);
            result = {
              from: parsed.from?.text || '',
              subject: parsed.subject || '',
              body: parsed.text || parsed.html || ''
            };
            lock.release();
            break;
          }
        } finally {
          try { lock.release(); } catch {}
        }
      } catch {}
    }
    await client.logout();
  } catch (err) {
    console.log(`[-] IMAP readMessage error: ${err.message}`);
  }

  return result;
}

// ─── WPForms submission ──────────────────────────────────────────

async function doRegistration() {
  const timestamp = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${timestamp}] starting registration...`);

  let mailAccount = null;

  for (let regAttempt = 1; regAttempt <= 8; regAttempt++) {
    try {
      console.log(`\n[*] Registration cycle attempt ${regAttempt}/8...`);
      mailAccount = await createTempMailAccount();
      let email = mailAccount.address;
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      const fullName = `${firstName} ${lastName}`;
      const country = pick(COUNTRIES);
      const device = pick(DEVICES);
      const iptv_app = pick(APPS);

      console.log(`[+] email: ${email}`);
      console.log(`[+] name: ${fullName}`);
      console.log(`[+] country: ${country}`);
      console.log(`[+] device: ${device}`);
      console.log(`[+] app: ${iptv_app}`);

      console.log(`[*] requesting email verification code...`);
      let sendRes = await httpRequest('https://iptvload.org/wp-json/ivl/v1/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://iptvload.org',
          'Referer': TARGET_URL
        },
        body: JSON.stringify({ form_id: 1019, email: email })
      });

      let sendData = {};
      try { sendData = JSON.parse(sendRes.body); } catch {}
      console.log(`[*] send response: ${JSON.stringify(sendData)}`);

      if (!sendData.ok) {
        console.log(`[-] send failed (${sendData.code || sendRes.status}): ${sendData.message || 'unknown error'}`);
        if (mailAccount.provider === 'simplelogin') await deleteTempMailAccount(mailAccount);
        await sleep(3000);
        continue;
      }

      console.log(`[+] verification code sent to ${email}!`);

      let verificationCode = null;
      const maxWaitMs = 90000;
      const pollIntervalMs = 6000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        console.log(`[*] checking inbox... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
        await sleep(pollIntervalMs);

        try {
          const messages = await checkInbox(mailAccount);
          for (const msg of messages) {
            const subject = msg.subject || '';
            const from = msg.from || '';

            // check subject for 6-digit code
            const subjectMatch = subject.match(/\b(\d{6})\b/);
            if (subjectMatch) {
              verificationCode = subjectMatch[1];
              console.log(`[+] VERIFICATION CODE FROM SUBJECT: ${verificationCode}`);
              break;
            }

            // read body for code
            const full = await readMessage(mailAccount, msg.id);
            const bodyText = full.body || '';
            const codeMatch = bodyText.match(/\b(\d{6})\b/);
            if (codeMatch) {
              verificationCode = codeMatch[1];
              console.log(`[+] VERIFICATION CODE FOUND IN BODY: ${verificationCode}`);
              break;
            }
          }
        } catch (err) {
          console.log(`[-] inbox check error: ${err.message}`);
        }

        if (verificationCode) break;
      }

      if (!verificationCode) {
        console.error(`[-] could not retrieve verification code within ${maxWaitMs / 1000}s, retrying with fresh email...`);
        if (mailAccount.provider === 'simplelogin') await deleteTempMailAccount(mailAccount);
        continue;
      }

      console.log(`[*] verifying code ${verificationCode}...`);
      const verifyRes = await httpRequest('https://iptvload.org/wp-json/ivl/v1/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://iptvload.org',
          'Referer': TARGET_URL
        },
        body: JSON.stringify({ form_id: 1019, email: email, code: verificationCode })
      });

      let verifyData = {};
      try { verifyData = JSON.parse(verifyRes.body); } catch {}
      console.log(`[*] verify response: ${JSON.stringify(verifyData)}`);

      if (!verifyData.ok || !verifyData.token) {
        console.error(`[-] verification failed: ${verifyData.message || verifyData.code}, retrying...`);
        if (mailAccount.provider === 'simplelogin') await deleteTempMailAccount(mailAccount);
        continue;
      }

      const ivlToken = verifyData.token;
      console.log(`[+] email verified! ivl_token: ${ivlToken.substring(0, 20)}...`);

      console.log(`[*] fetching registration page for tokens...`);
      const pageRes = await httpRequest(TARGET_URL);
      const cookies = (pageRes.cookies || []).map(c => c.split(';')[0]).join('; ');
      const timeTokenMatch = (pageRes.body || '').match(/name="wpforms\[time_token\]"\s+value="([^"]+)"/);
      const timeToken = timeTokenMatch ? timeTokenMatch[1] : '';

      const bodyParams = new URLSearchParams();
      bodyParams.append('wpforms[fields][1]', fullName);
      bodyParams.append('wpforms[fields][1][first]', firstName);
      bodyParams.append('wpforms[fields][1][last]', lastName);
      bodyParams.append('wpforms[fields][36]', country);
      bodyParams.append('wpforms[fields][2]', email);
      bodyParams.append('wpforms[fields][3]', '');
      bodyParams.append('wpforms[fields][5]', device);
      bodyParams.append('wpforms[fields][9]', iptv_app);
      bodyParams.append('wpforms[fields][23]', 'I would like to try your IPTV service please. Thank you!');

      bodyParams.append('wpforms[id]', '1019');
      bodyParams.append('wpforms[post_id]', '1321');
      if (timeToken) bodyParams.append('wpforms[time_token]', timeToken);
      bodyParams.append('wpforms[hp]', '');
      bodyParams.append('page_title', 'Free IPTV Trial');
      bodyParams.append('page_url', TARGET_URL);
      bodyParams.append('page_id', '1321');
      bodyParams.append('action', 'wpforms_submit');
      bodyParams.append('ivl_token', ivlToken);

      console.log(`[*] submitting WPForms...`);
      const submitUrl = 'https://iptvload.org/wp-admin/admin-ajax.php';
      const submitRes = await httpRequest(submitUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookies,
          'Referer': TARGET_URL,
          'Origin': 'https://iptvload.org',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: bodyParams.toString()
      });

      console.log(`[*] submit response: ${submitRes.status}`);
      console.log(`[*] response body: ${submitRes.body.substring(0, 400)}`);

      let formSuccess = false;
      try {
        const result = JSON.parse(submitRes.body);
        if (result.success || (result.data && !result.data.errors)) {
          console.log(`[+] FORM SUBMITTED SUCCESSFULLY!`);
          formSuccess = true;
        } else {
          console.log(`[-] submission failed: ${JSON.stringify(result).substring(0, 400)}`);
          if (submitRes.body.includes('already been used')) {
            console.log(`[-] email was previously used, retrying with fresh email...`);
            if (mailAccount.provider === 'simplelogin') await deleteTempMailAccount(mailAccount);
            await sleep(3000);
            continue;
          }
        }
      } catch {
        if (submitRes.status === 200 || submitRes.status === 302) {
          console.log(`[+] form submitted (non-JSON response)`);
          formSuccess = true;
        }
      }

      if (!formSuccess) {
        if (mailAccount.provider === 'simplelogin') await deleteTempMailAccount(mailAccount);
        await sleep(3000);
        continue;
      }

      console.log(`[*] waiting for IPTV credentials email (polling up to 4 minutes)...`);
      let foundCreds = false;
      for (let pollAttempt = 1; pollAttempt <= 16; pollAttempt++) {
        await sleep(15000);

        // Check temp mail account inbox
        const messages = await checkInbox(mailAccount);
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            if (msg.subject && msg.subject.toLowerCase().includes('verification code')) continue;
            const full = await readMessage(mailAccount, msg.id);
            console.log(`[+] candidate email from: ${full.from || 'unknown'} | subject: ${full.subject}`);
            const bodyText = (full.body || '').replace(/<[^>]+>/g, ' ');

            const creds = extractCredentials(bodyText);
            if (creds.username && creds.password) {
              activeCreds.username = creds.username;
              activeCreds.password = creds.password;
              activeCreds.portalUrl = creds.portalUrl || null;
              activeCreds.servers = creds.servers || [];
              activeCreds.registeredAt = new Date().toISOString();
              foundCreds = true;
              break;
            }
          }
        }

        // Also check Gmail IMAP as secondary
        if (!foundCreds && IMAP_CONFIG.auth.user) {
          try {
            const imapMessages = await checkInbox({ provider: 'gmail_imap', createdAt: new Date(Date.now() - 300000) });
            for (const msg of imapMessages) {
              if (msg.subject && msg.subject.toLowerCase().includes('verification code')) continue;
              const full = await readMessage({ provider: 'gmail_imap' }, msg.id);
              const bodyText = (full.body || '').replace(/<[^>]+>/g, ' ');
              const creds = extractCredentials(bodyText);
              if (creds.username && creds.password) {
                activeCreds.username = creds.username;
                activeCreds.password = creds.password;
                activeCreds.portalUrl = creds.portalUrl || null;
                activeCreds.servers = creds.servers || [];
                activeCreds.registeredAt = new Date().toISOString();
                foundCreds = true;
                break;
              }
            }
          } catch {}
        }

        if (foundCreds) {
          try {
            fs.writeFileSync(CREDS_FILE, JSON.stringify(activeCreds, null, 2));
          } catch (e) {
            console.log(`[-] error saving creds to disk: ${e.message}`);
          }

          console.log(`[+] ═══════════════════════════════════════`);
          console.log(`[+] IPTV CREDENTIALS STORED FOR PROXY:`);
          console.log(`[+]   username: ${activeCreds.username}`);
          console.log(`[+]   password: ${activeCreds.password}`);
          console.log(`[+]   servers:  ${activeCreds.servers.join(', ')}`);
          console.log(`[+]   portal:   ${activeCreds.portalUrl || 'N/A'}`);
          console.log(`[+] ═══════════════════════════════════════`);
          break;
        }
      }

      if (mailAccount.provider === 'simplelogin') {
        await deleteTempMailAccount(mailAccount);
      }

      const overallSuccess = formSuccess && !!activeCreds.username;
      console.log(`[${new Date().toISOString()}] registration cycle complete (${overallSuccess ? 'SUCCESS' : 'SUBMITTED - PENDING CREDENTIALS'})`);
      return overallSuccess;

    } catch (err) {
      console.error(`[-] registration attempt ${regAttempt} error: ${err.message}`);
      if (mailAccount && mailAccount.provider === 'simplelogin') {
        await deleteTempMailAccount(mailAccount);
      }
      await sleep(4000);
    }
  }

  console.error(`[-] all registration attempts exhausted`);
  return false;
}

// ─── IPTV proxy config & routes ───────────────────────────────────

const PROXY_USER = process.env.PROXY_USER || 'szaby';
const PROXY_PASS = process.env.PROXY_PASS || '2002';
const CREDS_FILE = path.join(__dirname, 'active_creds.json');

let activeCreds = {
  username: null,
  password: null,
  servers: [],
  portalUrl: null,
  registeredAt: null
};

try {
  if (fs.existsSync(CREDS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (saved && saved.username && saved.password) {
      activeCreds = saved;
      activeCreds.username = activeCreds.username.replace(/[*]/g, '').trim();
      activeCreds.password = activeCreds.password.replace(/[*]/g, '').replace(/Start.*$/i, '').trim();
      console.log(`[+] loaded saved active credentials: ${activeCreds.username}`);
    }
  }
} catch (e) {
  console.log(`[-] error reading saved creds: ${e.message}`);
}

function extractCredentials(bodyText) {
  const creds = {};

  const portalMatch = bodyText.match(/(https?:\/\/[^\s"'<>]+\/get\.php[^\s"'<>]*)/i);
  if (portalMatch) {
    creds.portalUrl = portalMatch[1];
    try {
      const parsed = new URL(creds.portalUrl);
      if (parsed.searchParams.get('username')) creds.username = parsed.searchParams.get('username');
      if (parsed.searchParams.get('password')) creds.password = parsed.searchParams.get('password');
    } catch {}
  }

  if (!creds.username) {
    const userMatch = bodyText.match(/USERNAME\s*:?\s*\*?([a-zA-Z0-9_\-]+)\*?/i);
    if (userMatch) creds.username = userMatch[1].replace(/[*]/g, '').trim();
  }

  if (!creds.password) {
    const passMatch = bodyText.match(/PASSWORD\s*:?\s*\*?([a-zA-Z0-9_\-]+)\*?/i);
    if (passMatch) creds.password = passMatch[1].replace(/[*]/g, '').trim();
  }

  const serverPattern = /(https?:\/\/[^\s"'<>]+(?:\.site|\.link|\.com|\.net|\.org|\.tv|\.stream|\.live)[\/]?)/gi;
  const servers = [];
  let m;
  while ((m = serverPattern.exec(bodyText)) !== null) {
    const url = m[1].replace(/\/$/, '');
    if (!url.includes('iptvload.org') && !url.includes('simplelogin') && !url.includes('get.php') && !url.includes('n8n.io') && !url.includes('mysortqr') && !servers.includes(url)) {
      servers.push(url);
    }
  }
  if (servers.length > 0) creds.servers = servers;

  if (creds.portalUrl) {
    try {
      const parsed = new URL(creds.portalUrl);
      const baseServer = `${parsed.protocol}//${parsed.host}`;
      if (!creds.servers) creds.servers = [];
      if (!creds.servers.includes(baseServer)) creds.servers.unshift(baseServer);
    } catch {}
  }

  return creds;
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function proxyRequest(upstreamUrl, req, res) {
  const parsed = new URL(upstreamUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  const reqHeaders = {
    'User-Agent': req.headers['user-agent'] || 'IPTVSmartersPro/3.1.5',
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': req.headers['accept-encoding'] || 'gzip, deflate'
  };

  const proxyReq = client.request({
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: reqHeaders
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[-] proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream server error', message: err.message });
    }
  });

  proxyReq.end();
}

function getCredentials(req) {
  const username = req.query.username || (req.body && req.body.username) || '';
  const password = req.query.password || (req.body && req.body.password) || '';
  const action = req.query.action || (req.body && req.body.action) || '';
  return { username, password, action };
}

function isAuthed(user, pass) {
  const isCustom = (user === PROXY_USER && (pass === PROXY_PASS || pass === '2002' || pass === 'szaby'));
  const isTrial = activeCreds.username && (user === activeCreds.username && pass === activeCreds.password);
  return isCustom || isTrial;
}

function checkProxyAuth(req, res) {
  const { username, password } = getCredentials(req);

  if (!isAuthed(username, password)) {
    res.status(401).json({ error: 'invalid credentials' });
    return false;
  }

  if (!activeCreds.username || !activeCreds.password || activeCreds.servers.length === 0) {
    res.status(503).json({ error: 'no active IPTV trial — wait for next registration cycle' });
    return false;
  }

  return true;
}

function getUpstreamServer() {
  const servers = activeCreds.servers || [];
  const cf = servers.find(s => s.includes('cf.') || s.includes('trial-one'));
  if (cf) return cf;
  const link = servers.find(s => s.includes('iptvload.link'));
  if (link) return link;
  const bcdn = servers.find(s => s.includes('business-cdn'));
  if (bcdn) return bcdn;
  if (activeCreds.portalUrl) {
    try {
      const parsed = new URL(activeCreds.portalUrl);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {}
  }
  return servers[0] || 'http://cf.trial-onetvup.site';
}

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'iptv-proxy',
    proxy_user: PROXY_USER,
    has_active_trial: !!(activeCreds.username),
    active_since: activeCreds.registeredAt,
    servers: activeCreds.servers,
    next_run_hours: REGISTER_INTERVAL_HOURS,
    uptime: process.uptime()
  });
});

app.get('/trigger', async (req, res) => {
  res.json({ message: 'registration triggered manually' });
  runRegistration();
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(runtimeLogs.join('\n'));
});

app.all('/get.php', (req, res) => {
  if (!checkProxyAuth(req, res)) return;
  const server = getUpstreamServer();
  const allParams = { ...(req.query || {}), ...(req.body || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;
  const searchParams = new URLSearchParams(allParams);
  proxyRequest(`${server}/get.php?${searchParams.toString()}`, req, res);
});

app.all('/player_api.php', async (req, res) => {
  if (!checkProxyAuth(req, res)) return;
  const { action } = getCredentials(req);
  const server = getUpstreamServer();
  const allParams = { ...(req.body || {}), ...(req.query || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(allParams)) {
    if (v !== undefined && v !== null) searchParams.set(k, String(v));
  }

  const upstreamUrl = `${server}/player_api.php?${searchParams.toString()}`;

  if (!action) {
    try {
      const resp = await fetch(upstreamUrl, {
        headers: { 'User-Agent': req.headers['user-agent'] || 'IPTVSmartersPro/3.1.5', 'Accept': 'application/json' }
      });
      const data = await resp.json();
      if (data && data.user_info && data.server_info) {
        const proxyHost = req.get('x-forwarded-host') || req.get('host') || 'localhost';
        const proxyProto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
        const hostOnly = proxyHost.split(':')[0];
        const portOnly = proxyHost.split(':')[1] || (proxyProto === 'https' ? '443' : '80');

        data.user_info.username = PROXY_USER;
        data.user_info.password = PROXY_PASS;
        data.user_info.auth = 1;
        data.user_info.status = 'Active';
        data.user_info.exp_date = '2145225600';
        data.server_info.url = hostOnly;
        data.server_info.port = portOnly;
        data.server_info.server_protocol = proxyProto;
        data.server_info.https_port = '443';
      }
      return res.json(data);
    } catch (e) {
      return proxyRequest(upstreamUrl, req, res);
    }
  }

  proxyRequest(upstreamUrl, req, res);
});

app.all('/xmltv.php', (req, res) => {
  if (!checkProxyAuth(req, res)) return;
  const server = getUpstreamServer();
  const allParams = { ...(req.query || {}), ...(req.body || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;
  const searchParams = new URLSearchParams(allParams);
  proxyRequest(`${server}/xmltv.php?${searchParams.toString()}`, req, res);
});

app.get('/:type(live|movie|series)/:user/:pass/*', (req, res) => {
  const { type, user, pass } = req.params;
  const streamPath = req.params[0];
  if (!isAuthed(user, pass) || !activeCreds.username) return res.status(401).json({ error: 'unauthorized' });
  const server = getUpstreamServer();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.redirect(302, `${server}/${type}/${activeCreds.username}/${activeCreds.password}/${streamPath}`);
});

app.get('/:user/:pass/:stream', (req, res, next) => {
  const { user, pass, stream } = req.params;
  if (!isAuthed(user, pass)) return next();
  if (!activeCreds.username) return res.status(503).json({ error: 'no active trial' });
  const server = getUpstreamServer();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.redirect(302, `${server}/live/${activeCreds.username}/${activeCreds.password}/${stream}`);
});

async function syncLatestCredsFromInbox() {
  try {
    const client = new ImapFlow(IMAP_CONFIG);
    await client.connect();
    for (const box of ['INBOX', '[Gmail]/Spam']) {
      try {
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await client.search({ from: 'iptvload' }, { uid: true });
          if (uids && uids.length > 0) {
            for (const uid of uids.reverse()) {
              const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
              if (msg && msg.envelope.subject && msg.envelope.subject.toLowerCase().includes('trial')) {
                const parsed = await simpleParser(msg.source);
                const creds = extractCredentials(parsed.text || parsed.html || '');
                if (creds.username && creds.password) {
                  activeCreds.username = creds.username;
                  activeCreds.password = creds.password;
                  activeCreds.portalUrl = creds.portalUrl || null;
                  activeCreds.servers = creds.servers || [];
                  activeCreds.registeredAt = msg.envelope.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString();
                  console.log(`[+] Synced latest IPTV creds from mailbox: ${activeCreds.username} (password: ${activeCreds.password})`);
                  try { fs.writeFileSync(CREDS_FILE, JSON.stringify(activeCreds, null, 2)); } catch {}
                  lock.release();
                  await client.logout();
                  return true;
                }
              }
            }
          }
        } finally {
          try { lock.release(); } catch {}
        }
      } catch {}
    }
    await client.logout();
  } catch (err) {
    console.log(`[-] Mailbox creds sync warning: ${err.message}`);
  }
  return false;
}

async function runRegistration() {
  await doRegistration();
}

app.listen(PORT, async () => {
  console.log(`[*] server running on port ${PORT}`);
  await syncLatestCredsFromInbox();
  setTimeout(() => { runRegistration(); }, 10000);
  setInterval(() => { runRegistration(); }, REGISTER_INTERVAL_HOURS * 3600000);
});
