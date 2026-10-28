// Node.js — IPTV auto-registration service for render.com
// submits WPForms free trial form every 20 hours with a fresh temp email

const express = require('express');
const cron = require('node-cron');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── config ───────────────────────────────────────────────────────
const TARGET_URL = 'https://iptvload.org/iptv-free-trial-4/';
const REGISTER_INTERVAL_HOURS = 20;

// temp mail API — mail.tm (REST API, creates real accounts)
const MAIL_TM_API = 'https://api.mail.tm';

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
// exact values from WPForms field 9 select options
const APPS = ['Iptv Smarters Pro', 'Tivimate', 'Kodi', 'OTT Player', 'GSE Smart IPTV', 'Smart IPTV'];

// ─── helpers ──────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateUsername() {
  const first = pick(FIRST_NAMES).toLowerCase();
  const last = pick(LAST_NAMES).toLowerCase();
  const num = randInt(10, 9999);
  const patterns = [
    `${first}.${last}${num}`,
    `${first}${last}${num}`,
    `${first}_${last}${randInt(1, 99)}`,
    `${first}${randInt(100, 999)}`,
    `${last}.${first}${randInt(1, 99)}`
  ];
  return pick(patterns);
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

// ─── temp email (multi-provider: mail.tm primary, guerrilla fallback) ──

const GUERRILLA_API = 'https://api.guerrillamail.com/ajax.php';

async function getMailTmDomain() {
  const res = await httpRequest(`${MAIL_TM_API}/domains`);
  if (res.status !== 200) throw new Error(`mail.tm domains: ${res.status}`);
  const data = JSON.parse(res.body);
  const domains = data['hydra:member'].filter(d => d.isActive);
  if (domains.length === 0) throw new Error('no active mail.tm domains');
  return pick(domains).domain;
}

async function tryMailTm() {
  const domain = await getMailTmDomain();
  const username = generateUsername();
  const address = `${username}@${domain}`;
  const password = `Pass${randInt(100000, 999999)}!`;

  const createRes = await httpRequest(`${MAIL_TM_API}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });

  if (createRes.status !== 201) {
    throw new Error(`mail.tm create: ${createRes.status} ${createRes.body.substring(0, 100)}`);
  }

  const tokenRes = await httpRequest(`${MAIL_TM_API}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password })
  });

  if (tokenRes.status !== 200) {
    throw new Error(`mail.tm token: ${tokenRes.status}`);
  }

  const tokenData = JSON.parse(tokenRes.body);
  return { provider: 'mailtm', address, token: tokenData.token };
}

async function tryGuerrilla() {
  // get a session + email address
  const res = await httpRequest(`${GUERRILLA_API}?f=get_email_address&lang=en`);
  if (res.status !== 200) throw new Error(`guerrilla: ${res.status}`);
  const data = JSON.parse(res.body);

  // try to set a custom username for a less-suspicious look
  const username = generateUsername();
  const setRes = await httpRequest(`${GUERRILLA_API}?f=set_email_user&email_user=${encodeURIComponent(username)}&lang=en&sid_token=${data.sid_token}`);
  const setData = JSON.parse(setRes.body);

  return {
    provider: 'guerrilla',
    address: setData.email_addr || data.email_addr,
    sid_token: data.sid_token
  };
}

async function createTempMailAccount() {
  // try mail.tm with retries first (better domains)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[*] mail.tm attempt ${attempt}/3...`);
      const account = await tryMailTm();
      console.log(`[+] mail.tm success: ${account.address}`);
      return account;
    } catch (err) {
      console.log(`[-] mail.tm attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await sleep(2000 * attempt); // exponential backoff
    }
  }

  // fallback to guerrilla mail
  console.log(`[*] falling back to guerrilla mail...`);
  try {
    const account = await tryGuerrilla();
    console.log(`[+] guerrilla mail: ${account.address}`);
    return account;
  } catch (err) {
    throw new Error(`all temp mail providers failed. last error: ${err.message}`);
  }
}

async function checkInbox(account) {
  if (account.provider === 'mailtm') {
    const res = await httpRequest(`${MAIL_TM_API}/messages`, {
      headers: { 'Authorization': `Bearer ${account.token}` }
    });
    const data = JSON.parse(res.body);
    return (data['hydra:member'] || []).map(m => ({ id: m.id, from: m.from?.address, subject: m.subject }));
  } else {
    // guerrilla
    const res = await httpRequest(`${GUERRILLA_API}?f=check_email&sid_token=${account.sid_token}&seq=0`);
    const data = JSON.parse(res.body);
    return (data.list || []).map(m => ({ id: m.mail_id, from: m.mail_from, subject: m.mail_subject }));
  }
}

async function readMessage(account, msgId) {
  if (account.provider === 'mailtm') {
    const res = await httpRequest(`${MAIL_TM_API}/messages/${msgId}`, {
      headers: { 'Authorization': `Bearer ${account.token}` }
    });
    const data = JSON.parse(res.body);
    return { from: data.from?.address, subject: data.subject, body: data.text || data.html || '' };
  } else {
    const res = await httpRequest(`${GUERRILLA_API}?f=fetch_email&sid_token=${account.sid_token}&email_id=${msgId}`);
    const data = JSON.parse(res.body);
    return { from: data.mail_from, subject: data.mail_subject, body: data.mail_body || '' };
  }
}

// ─── WPForms extraction & submission ─────────────────────────────

// ─── WPForms submission (hardcoded field IDs from page inspection) ──
// form ID: 1019 | page ID: 1321
// field 1: Name (first/last) | field 36: Country (select)
// field 2: Email | field 3: HONEYPOT (must be empty!)
// field 5: Device Type (select) | field 8: Mac Address Device (conditional, skip)
// field 9: IPTV Application (select) | field 10: Mac Address App (conditional, skip)
// field 23: Note (textarea)

async function doRegistration() {
  const timestamp = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${timestamp}] starting registration...`);

  try {
    // 1. generate fresh temp email
    const mailAccount = await createTempMailAccount();
    const email = mailAccount.address;
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const country = pick(COUNTRIES);
    const device = pick(DEVICES);
    const iptv_app = pick(APPS);

    console.log(`[+] email: ${email}`);
    console.log(`[+] name: ${firstName} ${lastName}`);
    console.log(`[+] country: ${country}`);
    console.log(`[+] device: ${device}`);
    console.log(`[+] app: ${iptv_app}`);

    // 2. fetch the page to get time_token
    console.log(`[*] fetching registration page...`);
    const pageRes = await httpRequest(TARGET_URL);

    if (pageRes.status !== 200) {
      console.error(`[-] page returned ${pageRes.status}`);
      return false;
    }

    const html = pageRes.body;
    const cookies = pageRes.cookies.map(c => c.split(';')[0]).join('; ');

    const timeTokenMatch = html.match(/name="wpforms\[time_token\]"\s+value="([^"]+)"/);
    const timeToken = timeTokenMatch ? timeTokenMatch[1] : '';
    console.log(`[*] time_token: ${timeToken ? 'found' : 'missing'}`);

    // 3. EMAIL VERIFICATION FLOW
    // step a: request verification code via REST API
    console.log(`[*] requesting email verification code...`);
    const sendRes = await httpRequest('https://iptvload.org/wp-json/ivl/v1/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://iptvload.org',
        'Referer': TARGET_URL
      },
      body: JSON.stringify({ form_id: 1019, email: email })
    });

    const sendData = JSON.parse(sendRes.body);
    console.log(`[*] send response: ${JSON.stringify(sendData)}`);

    if (!sendData.ok) {
      console.error(`[-] failed to send verification code: ${sendData.message || sendData.code}`);
      return false;
    }

    console.log(`[+] verification code sent to ${email}!`);

    // step b: poll inbox for the 6-digit code (try for up to 120 seconds)
    let verificationCode = null;
    const maxWaitMs = 120000;
    const pollIntervalMs = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      console.log(`[*] checking inbox... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
      await sleep(pollIntervalMs);

      try {
        const messages = await checkInbox(mailAccount);
        for (const msg of messages) {
          // skip guerrilla welcome emails
          if (msg.subject && msg.subject.includes('Welcome to Guerrilla')) continue;

          const full = await readMessage(mailAccount, msg.id);
          const bodyText = full.body || '';
          console.log(`[*] email from: ${full.from} | subject: ${full.subject}`);

          // look for 6-digit code in the email body
          const codeMatch = bodyText.match(/\b(\d{6})\b/);
          if (codeMatch) {
            verificationCode = codeMatch[1];
            console.log(`[+] VERIFICATION CODE FOUND: ${verificationCode}`);
            break;
          }

          // also try to find it in subject
          const subjectMatch = (full.subject || '').match(/\b(\d{6})\b/);
          if (subjectMatch) {
            verificationCode = subjectMatch[1];
            console.log(`[+] VERIFICATION CODE FROM SUBJECT: ${verificationCode}`);
            break;
          }
        }
      } catch (err) {
        console.log(`[-] inbox check error: ${err.message}`);
      }

      if (verificationCode) break;
    }

    if (!verificationCode) {
      console.error(`[-] could not retrieve verification code within ${maxWaitMs / 1000}s`);
      return false;
    }

    // step c: verify the code to get ivl_token
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

    const verifyData = JSON.parse(verifyRes.body);
    console.log(`[*] verify response: ${JSON.stringify(verifyData)}`);

    if (!verifyData.ok || !verifyData.token) {
      console.error(`[-] verification failed: ${verifyData.message || verifyData.code}`);
      return false;
    }

    const ivlToken = verifyData.token;
    console.log(`[+] email verified! ivl_token: ${ivlToken.substring(0, 20)}...`);

    // 4. build form body with exact field IDs + ivl_token
    const bodyParams = new URLSearchParams();

    bodyParams.append('wpforms[fields][1][first]', firstName);
    bodyParams.append('wpforms[fields][1][last]', lastName);
    bodyParams.append('wpforms[fields][36]', country);
    bodyParams.append('wpforms[fields][2]', email);
    bodyParams.append('wpforms[fields][3]', ''); // honeypot
    bodyParams.append('wpforms[fields][5]', device);
    bodyParams.append('wpforms[fields][9]', iptv_app);
    bodyParams.append('wpforms[fields][23]', 'I would like to try your IPTV service please. Thank you!');

    // hidden meta fields
    bodyParams.append('wpforms[id]', '1019');
    bodyParams.append('wpforms[post_id]', '1321');
    if (timeToken) bodyParams.append('wpforms[time_token]', timeToken);
    bodyParams.append('wpforms[hp]', '');
    bodyParams.append('page_title', 'Free IPTV Trial');
    bodyParams.append('page_url', TARGET_URL);
    bodyParams.append('page_id', '1321');
    bodyParams.append('action', 'wpforms_submit');
    // email verification token
    bodyParams.append('ivl_token', ivlToken);

    console.log(`[*] submitting form with verified email...`);

    // 5. submit via AJAX
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
    console.log(`[*] response body: ${submitRes.body.substring(0, 500)}`);

    let success = false;
    try {
      const result = JSON.parse(submitRes.body);
      if (result.success || (result.data && !result.data.errors)) {
        console.log(`[+] FORM SUBMITTED SUCCESSFULLY!`);
        success = true;
      } else {
        console.log(`[-] submission failed: ${JSON.stringify(result).substring(0, 500)}`);
        if (result.data && result.data.errors) {
          for (const [k, v] of Object.entries(result.data.errors)) {
            console.log(`    ${k}: ${JSON.stringify(v).replace(/<[^>]+>/g, '').substring(0, 200)}`);
          }
        }
      }
    } catch {
      if (submitRes.status === 200 || submitRes.status === 302) {
        console.log(`[+] form submitted (non-JSON response)`);
        success = true;
      }
    }

    // 6. check email for IPTV credentials
    if (success) {
      console.log(`[*] waiting 90s for IPTV credentials email...`);
      await sleep(90000);
      const messages = await checkInbox(mailAccount);
      if (messages.length > 0) {
        console.log(`[+] received ${messages.length} email(s)!`);
        for (const msg of messages) {
          if (msg.subject && msg.subject.includes('Welcome to Guerrilla')) continue;
          if (msg.subject && msg.subject.includes('verification code')) continue;
          const full = await readMessage(mailAccount, msg.id);
          console.log(`    from: ${full.from || 'unknown'} | subject: ${full.subject}`);
          const bodyText = (full.body || '').replace(/<[^>]+>/g, ' ');

          // extract and store IPTV credentials for the proxy
          const creds = extractCredentials(bodyText);
          if (creds.username && creds.password) {
            activeCreds.username = creds.username;
            activeCreds.password = creds.password;
            activeCreds.portalUrl = creds.portalUrl || null;
            activeCreds.servers = creds.servers || [];
            activeCreds.registeredAt = new Date().toISOString();

            console.log(`[+] ═══════════════════════════════════════`);
            console.log(`[+] IPTV CREDENTIALS STORED FOR PROXY:`);
            console.log(`[+]   username: ${activeCreds.username}`);
            console.log(`[+]   password: ${activeCreds.password}`);
            console.log(`[+]   servers:  ${activeCreds.servers.join(', ')}`);
            console.log(`[+]   portal:   ${activeCreds.portalUrl || 'N/A'}`);
            console.log(`[+] ═══════════════════════════════════════`);
          }

          console.log(`[*] email body: ${bodyText.substring(0, 500)}`);
        }
      } else {
        console.log(`[*] no credential emails yet`);
      }
    }

    console.log(`[${new Date().toISOString()}] registration cycle complete (${success ? 'SUCCESS' : 'FAILED'})`);
    return success;

  } catch (err) {
    console.error(`[-] registration error: ${err.message}`);
    console.error(err.stack);
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── IPTV proxy config ────────────────────────────────────────────

const PROXY_USER = process.env.PROXY_USER || 'myuser';
const PROXY_PASS = process.env.PROXY_PASS || 'mypass';

// active trial credentials — updated after each registration
let activeCreds = {
  username: null,
  password: null,
  servers: [],       // e.g. ['http://cf.trial-onetvup.site/', 'http://iptvload.link/']
  portalUrl: null,    // full get.php URL
  registeredAt: null
};

// ─── credential extraction from registration email ────────────────

function extractCredentials(bodyText) {
  const creds = {};

  // username
  const userMatch = bodyText.match(/USERNAME\s+(\S+)/i);
  if (userMatch) creds.username = userMatch[1];

  // password
  const passMatch = bodyText.match(/PASSWORD\s+(\S+)/i);
  if (passMatch) creds.password = passMatch[1];

  // portal URL (get.php)
  const portalMatch = bodyText.match(/(https?:\/\/[^\s"'<>]+\/get\.php[^\s"'<>]*)/i);
  if (portalMatch) creds.portalUrl = portalMatch[1];

  // extract server URLs — look for http:// URLs that look like IPTV servers
  const serverPattern = /(https?:\/\/[^\s"'<>]+(?:\.site|\.link|\.com|\.net|\.org|\.tv|\.stream|\.live)[\/]?)/gi;
  const servers = [];
  let m;
  while ((m = serverPattern.exec(bodyText)) !== null) {
    const url = m[1].replace(/\/$/, '');
    // skip iptvload.org itself and obvious non-server URLs
    if (!url.includes('iptvload.org') && !url.includes('get.php') && !servers.includes(url)) {
      servers.push(url);
    }
  }
  if (servers.length > 0) creds.servers = servers;

  // also extract from portal URL if present
  if (creds.portalUrl) {
    try {
      const parsed = new URL(creds.portalUrl);
      const baseServer = `${parsed.protocol}//${parsed.host}`;
      if (!creds.servers) creds.servers = [];
      if (!creds.servers.includes(baseServer)) creds.servers.unshift(baseServer);

      // extract username/password from URL params if not found in text
      if (!creds.username) creds.username = parsed.searchParams.get('username');
      if (!creds.password) creds.password = parsed.searchParams.get('password');
    } catch {}
  }

  return creds;
}

// ─── proxy helper: pipe request to upstream IPTV server ───────────

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── proxy helper: pipe request to upstream IPTV server ───────────

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

// ─── auth check ───────────────────────────────────────────────────

function getCredentials(req) {
  const username = req.query.username || (req.body && req.body.username) || '';
  const password = req.query.password || (req.body && req.body.password) || '';
  const action = req.query.action || (req.body && req.body.action) || '';
  return { username, password, action };
}

function isAuthed(user, pass) {
  const isCustom = (user === PROXY_USER && pass === PROXY_PASS);
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
  return activeCreds.servers[0];
}

// ─── express server + IPTV proxy ──────────────────────────────────

let lastRun = null;
let runCount = 0;
let lastStatus = 'not started';

// status endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'iptv-proxy',
    proxy_user: PROXY_USER,
    has_active_trial: !!(activeCreds.username),
    active_since: activeCreds.registeredAt,
    servers: activeCreds.servers,
    last_run: lastRun,
    run_count: runCount,
    last_status: lastStatus,
    next_run_hours: REGISTER_INTERVAL_HOURS,
    uptime: process.uptime()
  });
});

// manual trigger
app.get('/trigger', async (req, res) => {
  res.json({ message: 'registration triggered manually' });
  runRegistration();
});

// ─── Xtream Codes API proxy endpoints ─────────────────────────────

// ALL /get.php — M3U playlist
app.all('/get.php', (req, res) => {
  if (!checkProxyAuth(req, res)) return;

  const server = getUpstreamServer();
  const allParams = { ...(req.query || {}), ...(req.body || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;
  const searchParams = new URLSearchParams(allParams);
  const upstreamUrl = `${server}/get.php?${searchParams.toString()}`;

  console.log(`[proxy] ${req.method} /get.php → ${server}`);
  proxyRequest(upstreamUrl, req, res);
});

// ALL /player_api.php — Xtream Codes API (handles both GET and POST)
app.all('/player_api.php', async (req, res) => {
  if (!checkProxyAuth(req, res)) return;

  const { action } = getCredentials(req);
  const server = getUpstreamServer();

  const allParams = { ...(req.body || {}), ...(req.query || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(allParams)) {
    if (v !== undefined && v !== null) {
      searchParams.set(k, String(v));
    }
  }

  const upstreamUrl = `${server}/player_api.php?${searchParams.toString()}`;
  console.log(`[proxy] ${req.method} /player_api.php?action=${action || 'auth'} → ${server}`);

  // Auth / handshake request: rewrite user_info and server_info
  // so IPTV Smarters Pro saves our proxy domain & user/pass
  if (!action) {
    try {
      const resp = await fetch(upstreamUrl, {
        headers: {
          'User-Agent': req.headers['user-agent'] || 'IPTVSmartersPro/3.1.5',
          'Accept': 'application/json'
        }
      });
      const data = await resp.json();
      if (data && data.user_info && data.server_info) {
        const proxyHost = req.get('x-forwarded-host') || req.get('host') || 'localhost';
        const proxyProto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
        const hostOnly = proxyHost.split(':')[0];
        const portOnly = proxyHost.split(':')[1] || (proxyProto === 'https' ? '443' : '80');

        data.user_info.username = PROXY_USER;
        data.user_info.password = PROXY_PASS;
        data.server_info.url = hostOnly;
        data.server_info.port = portOnly;
        data.server_info.server_protocol = proxyProto;
        data.server_info.https_port = '443';
      }
      return res.json(data);
    } catch (e) {
      console.error(`[-] auth rewrite fallback: ${e.message}`);
      return proxyRequest(upstreamUrl, req, res);
    }
  }

  // All other actions (categories, streams, epg)
  proxyRequest(upstreamUrl, req, res);
});

// ALL /xmltv.php — EPG data
app.all('/xmltv.php', (req, res) => {
  if (!checkProxyAuth(req, res)) return;

  const server = getUpstreamServer();
  const allParams = { ...(req.query || {}), ...(req.body || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;
  const searchParams = new URLSearchParams(allParams);
  const upstreamUrl = `${server}/xmltv.php?${searchParams.toString()}`;

  console.log(`[proxy] ${req.method} /xmltv.php → ${server}`);
  proxyRequest(upstreamUrl, req, res);
});

// GET /live/:user/:pass/* — live streams
app.get('/live/:user/:pass/*', (req, res) => {
  if (!isAuthed(req.params.user, req.params.pass)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (!activeCreds.username) {
    return res.status(503).json({ error: 'no active trial' });
  }

  const streamPath = req.params[0];
  const server = getUpstreamServer();
  const upstreamUrl = `${server}/live/${activeCreds.username}/${activeCreds.password}/${streamPath}`;

  console.log(`[proxy] LIVE → ${streamPath}`);
  proxyRequest(upstreamUrl, req, res);
});

// GET /movie/:user/:pass/* — VOD
app.get('/movie/:user/:pass/*', (req, res) => {
  if (!isAuthed(req.params.user, req.params.pass)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (!activeCreds.username) {
    return res.status(503).json({ error: 'no active trial' });
  }

  const filePath = req.params[0];
  const server = getUpstreamServer();
  const upstreamUrl = `${server}/movie/${activeCreds.username}/${activeCreds.password}/${filePath}`;

  console.log(`[proxy] MOVIE → ${filePath}`);
  proxyRequest(upstreamUrl, req, res);
});

// GET /series/:user/:pass/* — series
app.get('/series/:user/:pass/*', (req, res) => {
  if (!isAuthed(req.params.user, req.params.pass)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (!activeCreds.username) {
    return res.status(503).json({ error: 'no active trial' });
  }

  const filePath = req.params[0];
  const server = getUpstreamServer();
  const upstreamUrl = `${server}/series/${activeCreds.username}/${activeCreds.password}/${filePath}`;

  console.log(`[proxy] SERIES → ${filePath}`);
  proxyRequest(upstreamUrl, req, res);
});

// GET /:user/:pass/:stream — generic direct stream URL (without /live/ prefix)
app.get('/:user/:pass/:stream', (req, res, next) => {
  const { user, pass, stream } = req.params;
  if (!isAuthed(user, pass)) {
    return next();
  }
  if (!activeCreds.username) {
    return res.status(503).json({ error: 'no active trial' });
  }

  const server = getUpstreamServer();
  const upstreamUrl = `${server}/live/${activeCreds.username}/${activeCreds.password}/${stream}`;

  console.log(`[proxy] DIRECT STREAM → ${stream}`);
  proxyRequest(upstreamUrl, req, res);
});

// ─── registration runner ──────────────────────────────────────────

async function runRegistration() {
  runCount++;
  lastRun = new Date().toISOString();
  const result = await doRegistration();
  lastStatus = result ? 'success' : 'failed';
}

// override the credential extraction in doRegistration
// patch: after successful registration, extract and store credentials
const originalDoRegistration = doRegistration;

// ─── startup ──────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[*] server running on port ${PORT}`);
  console.log(`[*] IPTV proxy: user=${PROXY_USER}`);
  console.log(`[*] will register every ${REGISTER_INTERVAL_HOURS} hours`);
  console.log(`[*] endpoints:`);
  console.log(`    GET /                          → status`);
  console.log(`    GET /trigger                   → manual registration`);
  console.log(`    GET /get.php?username=X&password=Y&type=m3u_plus → M3U playlist`);
  console.log(`    GET /player_api.php?username=X&password=Y        → Xtream API`);
  console.log(`    GET /live/X/Y/stream.ts                          → live stream`);
  console.log(`    GET /movie/X/Y/file.mp4                          → VOD`);
  console.log(`    GET /series/X/Y/file.mp4                         → series`);

  // first run after 10 seconds
  setTimeout(() => {
    console.log('[*] running initial registration...');
    runRegistration();
  }, 10000);

  // then every 20 hours
  const intervalMs = REGISTER_INTERVAL_HOURS * 60 * 60 * 1000;
  setInterval(() => {
    console.log(`[*] ${REGISTER_INTERVAL_HOURS}h interval triggered`);
    runRegistration();
  }, intervalMs);
});
