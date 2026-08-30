// ═══════════════════════════════════════════════════════════════════════════
// G95 報告看板每日郵件（GitHub Actions 專用）V0828-A6
// 流程：開站 → 檢視碼登入（唯讀）→ 等資料載完 → 切報告看板
//       → 截 9 張圖（八卡總覽 + 八段名單出圖）→ Gmail SMTP 寄出
// 密碼來源：GitHub repo Secrets（GMAIL_APP_PASSWORD 由維護者本人設定，AI 不經手）
// 本機不會跑這支——它只在 GitHub Actions 的雲端主機上執行。
// ═══════════════════════════════════════════════════════════════════════════
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';

const BOARD_URL     = process.env.BOARD_URL || 'https://nasajetta-create.github.io/G95/';
const PASSCODE      = process.env.BOARD_PASSCODE || '';
const GMAIL_USER    = process.env.GMAIL_USER || '';
const GMAIL_APP_PW  = process.env.GMAIL_APP_PASSWORD || '';
const MAIL_TO       = process.env.MAIL_TO || GMAIL_USER;
const APPCHECK_DBG  = process.env.APPCHECK_DEBUG_TOKEN || '';
const OUT           = 'out';

function todayTW(){
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()); // YYYY-MM-DD
}
function safeName(s){ return String(s).replace(/[\\/:*?"<>|\s]+/g, '_'); }
function die(msg){ console.error('✗ ' + msg); process.exit(1); }

if (!PASSCODE)     die('缺 BOARD_PASSCODE（repo Secrets 未設定）');
if (!GMAIL_USER)   die('缺 GMAIL_USER（repo Secrets 未設定）');
if (!GMAIL_APP_PW) die('缺 GMAIL_APP_PASSWORD（repo Secrets 未設定）');
if (!APPCHECK_DBG) die('缺 APPCHECK_DEBUG_TOKEN（Firebase App Check 偵錯權杖——Run #7 證實：機房 IP 過不了 reCAPTCHA、Firestore 全拒讀，必須用偵錯權杖）');

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 2000 },
  deviceScaleFactor: 2,
  locale: 'zh-TW',
  timezoneId: 'Asia/Taipei'
});
// V0828-A6：App Check 偵錯權杖——在任何頁面腳本執行前掛上（官方 CI 作法）。
// 權杖要先在 Firebase Console → App Check → 管理偵錯權杖 登記過才有效。
await ctx.addInitScript(t => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = t; }, APPCHECK_DBG);
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
// V0828-A5：網頁 console 轉印到 Actions log（[defects] 就緒/逾時 這些訊息＝診斷關鍵）
page.on('console', m => { const t = m.text(); if (t && !t.startsWith('Failed to load resource')) console.log('[page]', t.slice(0, 300)); });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

try {
  // ── ① 開站＋檢視碼登入 ──────────────────────────────────────────────
  console.log('開站 ' + BOARD_URL);
  await page.goto(BOARD_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-pass', { timeout: 60000 });
  await page.fill('#login-pass', PASSCODE);
  await page.click('#login-passbtn');
  await page.waitForURL(u => u.href.includes('mode=view'), { timeout: 60000 });
  console.log('已進唯讀模式（?mode=view）');

  // ── ② 等資料載完（V0828-A3/A5）────────────────────────────────────────
  //     三關全過才算穩：①_dfActive（defects 就緒，_dfBoot 成功才設 true）
  //     ②_dfPartial/_dfStale 乾淨 ③八段計數指紋連續 30 秒不變。
  //     A5：站內首載有 60s×2 逾時保險絲，冷開機載 1.8 萬份文件若超過 120 秒
  //     ＝永久 _dfStale、之後等再久都不會轉正 ⇒ 偵測到 stale 就 reload 重來
  //     （等於自動按「重抓」），最多兩回合。
  const READY = () => page.waitForFunction(() => {
    try {
      if (typeof _bdData !== 'function' || typeof switchTab !== 'function') return false;
      if (window._dfStale) return 'stale';                     // 保險絲燒了＝這回合不用再等
      if (window._dfActive !== true) return false;             // ① defects 資料層就緒
      if (window._dfPartial) return false;                     // ② 沒有半載
      const D = _bdData(); let n = 0;
      const v = _BDSEG.map(s => { const o = D.brk[s.id] || {}; n += o.n || 0; return [o.n, o.A, o.B, o.S].join(','); }).join('|');
      const t = Date.now();
      if (!window.__mmFp || window.__mmFp.v !== v) { window.__mmFp = { v: v, t: t }; return false; }
      return (n > 0 && (t - window.__mmFp.t) > 30000) ? 'ok' : false;   // ③ 計數穩定 30 秒
    } catch (e) { return false; }
  }, null, { timeout: 240000, polling: 5000 });
  const DIAG = () => page.evaluate(() => {
    const o = { dfActive: window._dfActive, dfPartial: window._dfPartial, dfStale: window._dfStale, fbReady: window._fbReady, staleBanner: !!document.getElementById('df-stale-banner') };
    try { const D = _bdData(); o.counts = _BDSEG.map(s => s.id + ':' + ((D.brk[s.id] || {}).n || 0)).join(' '); } catch (e) { o.counts = 'ERR ' + e.message; }
    return JSON.stringify(o);
  }).then(s => console.log('[診斷]', s)).catch(() => {});
  let verdict;
  try { verdict = await READY().then(h => h.jsonValue()); } catch (e) { verdict = 'timeout'; }
  if (verdict !== 'ok') {
    console.log('第一回合未就緒（' + verdict + '），reload 重來一次…'); await DIAG();
    await page.reload({ waitUntil: 'domcontentloaded' });
    try { verdict = await READY().then(h => h.jsonValue()); } catch (e) { verdict = 'timeout'; }
  }
  if (verdict !== 'ok') { await DIAG(); throw new Error('資料載入未就緒（' + verdict + '）——診斷見上方 [診斷]/[page] 行'); }
  console.log('資料載入完成（defects 就緒＋計數 30 秒未變）');

  // ── ③ 切到報告看板 ──────────────────────────────────────────────────
  await page.evaluate(() => switchTab('board'));
  await page.waitForSelector('#bd-shot', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── ④ 截圖：0 總覽＋八段名單 ────────────────────────────────────────
  const files = [];
  const f0 = path.join(OUT, '0_總覽.png');
  await page.locator('#bd-shot').screenshot({ path: f0 });
  files.push(f0);
  console.log('0_總覽 ✓');

  const segs = await page.evaluate(() => _BDSEG.map(s => ({ id: s.id, no: s.no, name: s.name })));
  for (const s of segs) {
    await page.evaluate((id) => {
      let host = document.getElementById('mailcap');
      if (!host) {
        host = document.createElement('div');
        host.id = 'mailcap';
        host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff';
        document.getElementById('pane-board').appendChild(host);   // 放 #pane-board 內＝吃得到看板 CSS
      }
      host.innerHTML = _bdRosterHTML(id, _bdData());
    }, s.id);
    const fp = path.join(OUT, s.no + '_' + safeName(s.name) + '.png');
    await page.locator('#mailcap > div').screenshot({ path: fp });
    files.push(fp);
    console.log(s.no + '_' + s.name + ' ✓');
  }
  await page.evaluate(() => { const h = document.getElementById('mailcap'); if (h) h.remove(); });

  // ── ⑤ 信件內文＝看板「複製文字」同款摘要 ────────────────────────────
  const bodyText = await page.evaluate(() => {
    const D = _bdData(), L = ['【KIMZO 交屋進度】' + _bdStamp()];
    _BDSEG.filter(s => s.card).forEach(s => {
      const o = D.brk[s.id];
      L.push(s.no + '. ' + s.name + ' ' + o.n + '（A' + o.A + '/B' + o.B + '/店' + o.S + '）');
    });
    L.push('—'); L.push(_bdSummary(D).t);
    return L.join('\n');
  });

  await browser.close();

  // ── ⑥ Gmail SMTP 寄信（標準 MIME 附件）─────────────────────────────
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PW }
  });
  const info = await transporter.sendMail({
    from: '"KIMZO 報告看板" <' + GMAIL_USER + '>',
    to: MAIL_TO,
    subject: '【KIMZO 報告看板】' + todayTW() + ' 每日進度（9 張圖）',
    text: bodyText + '\n\n（本信由 GitHub Actions 每日自動寄出；附件＝八卡總覽 + 八段名單）',
    attachments: files.map(fp => ({ filename: path.basename(fp), path: fp }))
  });
  console.log('寄信完成 ' + info.messageId + '（' + files.length + ' 張附件）');
} catch (e) {
  try { await page.screenshot({ path: path.join(OUT, 'error.png'), fullPage: true }); } catch (_) {}
  try { await browser.close(); } catch (_) {}
  die('失敗：' + (e && e.message || e));
}
