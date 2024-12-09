const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const puppeteer = require('puppeteer');
require('dotenv').config();

const accounts = [];

try {
  const accountsFile = fs.readFileSync('accounts.json', 'utf8');
  const accountsData = JSON.parse(accountsFile);
  accounts.push(...accountsData);
} catch (err) {
  console.log('Không tìm thấy tệp account.json, sử dụng env');
  if (process.env.APP_USER && process.env.APP_PASS) {
    accounts.push({
      user: process.env.APP_USER,
      password: process.env.APP_PASS,
      proxy: process.env.PROXY
    });
  }
}

const extensionId = 'caacbgbklghmpodbdafajbgdnegacfmo';
const CRX_URL = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=98.0.4758.102&acceptformat=crx2,crx3&x=id%3D${extensionId}%26uc&nacl_arch=x86-64`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36';
const ALLOW_DEBUG = process.env.ALLOW_DEBUG === 'True';
const EXTENSION_FILENAME = 'app.crx';

if (accounts.length === 0) {
  console.error('Không có tài khoản nào được định cấu hình! Vui lòng thêm tài khoản vào account.json hoặc env');
  process.exit(1);
}

console.log(`Tìm thấy ${accounts.length} tài khoản`);

async function downloadExtension(extensionId) {
  const url = CRX_URL.replace(extensionId, extensionId);
  const headers = { 'User-Agent': USER_AGENT };

  console.log('Downloading extension from:', url);

  if (fs.existsSync(EXTENSION_FILENAME)) {
    console.log('Extension already downloaded! skip download...');
    return;
  }

  try {
    const response = await axios.get(url, { headers, responseType: 'arraybuffer' });
    fs.writeFileSync(EXTENSION_FILENAME, response.data);
    if (ALLOW_DEBUG) {
      const md5 = crypto.createHash('md5').update(response.data).digest('hex');
      console.log('Extension MD5:', md5);
    }
  } catch (error) {
    console.error('Error downloading extension:', error);
    throw error;
  }
}

async function generateErrorReport(page) {
  await page.screenshot({ path: 'error.png' });

  const logs = await page.evaluate(() => {
    const errorLogs = [];
    console._stderr.forEach(log => errorLogs.push(log));
    return errorLogs;
  });

  fs.writeFileSync('error.log', logs.join('\n'));
}

async function getDriverOptions(account) {
  const options = {
    headless: true,
    args: [
      `--user-agent=${USER_AGENT}`,
      '--disable-web-security',
      '--disable-site-isolation-trials',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-ipv6',
      '--aggressive-cache-discard',
      '--disable-cache',
      '--disable-application-cache',
      '--disable-offline-load-stale-cache',
      '--disk-cache-size=0'
    ],
    defaultViewport: null
  };

  if (account.proxy) {
    console.log(`Setting up proxy for ${account.user}:`, account.proxy);

    let proxyUrl = account.proxy;
    if (!proxyUrl.includes('://')) {
      proxyUrl = `http://${proxyUrl}`;
    }

    options.args.push(`--proxy-server=${proxyUrl}`);
  }

  return options;
}

async function runAccount(account) {
  console.log(`Starting account ${account.user}...`);

  const options = await getDriverOptions(account);

  if (ALLOW_DEBUG) {
    options.args.push('--enable-logging', '--v=1');
  }

  let browser, page;
  try {
    browser = await puppeteer.launch(options);
    page = await browser.newPage();

    console.log(`Browser started for ${account.user}`);

    console.log(`Logging in ${account.user}...`);
    await page.goto('https://app.gradient.network/');

    await page.waitForSelector('[placeholder="Enter Email"]');
    await page.waitForSelector('[type="password"]');
    await page.waitForSelector('button');

    await page.type('[placeholder="Enter Email"]', account.user);
    await page.type('[type="password"]', account.password);
    await page.click('button');

    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    try {
      await page.waitForSelector('//*[contains(text(), "Sorry, Gradient is not yet available in your region.")]', { timeout: 5000 });
      console.log(`Gradient not available in region for ${account.user}`);
      await browser.close();
      return;
    } catch (error) {
      // Region is available, continue
    }

    console.log(`Navigating to extension for ${account.user}...`);
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await page.waitForSelector('//div[contains(text(), "Status")]');

    // Get status
    await page.waitForSelector('//div[contains(text(), "Today\'s Taps")]');

    const supportStatus = await page.$eval('.absolute.mt-3.right-0.z-10', el => el.textContent);

    console.log(`Status for ${account.user}:`, supportStatus);

    if (supportStatus.includes('Disconnected')) {
      console.log(`Failed to connect for ${account.user}`);
      await browser.close();
      return;
    }

    setInterval(async () => {
      const title = await page.title();
      console.log(`[${account.user}] Running...`, title);
      if (account.proxy) {
        console.log(`[${account.user}] Running with proxy ${account.proxy}...`);
      }
    }, 10000);

  } catch (error) {
    console.error(`Error with account ${account.user}:`, error);
    if (page) {
      await generateErrorReport(page);
      await browser.close();
    }
  }
}

async function main() {
  await downloadExtension(extensionId);

  const promises = accounts.map(account => runAccount(account));
  await Promise.all(promises);
}

main().catch(console.error);
