const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const QUEUE_BASE = 'https://promptdash-runner.lovable.app';
const WORKER_SECRET = 'A7mP4xQ9vN2rT8wL5sD3fH6jB1cY0zAz';

const PROMPTWATCH_URL = 'https://promptwatch.com/ai-visibility-report';
const PDF_FOLDER = path.join(process.env.USERPROFILE, 'Documents');

async function getNextUrl() {
  const response = await fetch(
    `${QUEUE_BASE}/api/public/promptwatch/next`,
    {
      method: 'POST',
      headers: {
        'x-worker-secret': WORKER_SECRET
      }
    }
  );

  if (!response.ok) {
    throw new Error(`GET NEXT failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.url) {
    return null;
  }

  return data;
}

async function markComplete(domain, pdfPath) {
  const response = await fetch(
    `${QUEUE_BASE}/api/public/promptwatch/complete`,
    {
      method: 'POST',
      headers: {
        'x-worker-secret': WORKER_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: domain,
        pdf_filename: path.basename(pdfPath)
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `COMPLETE callback failed: ${response.status} ${text}`
    );
  }
}

async function markError(domain, message) {
  const response = await fetch(
    `${QUEUE_BASE}/api/public/promptwatch/error`,
    {
      method: 'POST',
      headers: {
        'x-worker-secret': WORKER_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: domain,
        error_message: message
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    console.log(
      `ERROR CALLBACK FAILED: ${response.status} ${text}`
    );
  }
}

(async () => {

  const context = await chromium.launchPersistentContext(
    './promptwatch-profile',
    {
      headless: false
    }
  );

  const pages = context.pages();
  const page = pages[0] || await context.newPage();

  console.log('PROMPTWATCH WORKER STARTED');

  while (true) {

    let domain = null;

    try {

      const job = await getNextUrl();

      if (!job) {
  console.log('NO URLS WAITING - CHECKING AGAIN IN 10 SECONDS');
  await page.waitForTimeout(10000);
  continue;
}

      domain = job.url;

      console.log('');
      console.log('STARTING:', domain);

      await page.goto(PROMPTWATCH_URL, {
        waitUntil: 'domcontentloaded'
      });

      const websiteBox = page.getByRole(
        'textbox',
        { name: 'Enter your website' }
      );

      await websiteBox.waitFor({
        state: 'visible',
        timeout: 30000
      });

      await websiteBox.fill(domain);

      await page.getByRole(
        'button',
        { name: 'Scan my website' }
      ).click();

      console.log('SCAN STARTED:', domain);

      await page.getByText(
        'Visibility score',
        { exact: true }
      ).waitFor({
        state: 'visible',
        timeout: 300000
      });

      console.log('REPORT COMPLETE:', domain);

      await page.waitForTimeout(5000);




      const safeFilename =
        domain.replace(/[^a-zA-Z0-9.-]/g, '_');

      const pdfPath = path.join(
        PDF_FOLDER,
        `${safeFilename}-Promptwatch.pdf`
      );

      await page.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true
      });

      if (!fs.existsSync(pdfPath)) {
        throw new Error('PDF was not successfully saved');
      }

      if (fs.statSync(pdfPath).size === 0) {
        throw new Error('PDF was created but is empty');
      }

      console.log('PDF SAVED:', pdfPath);

  

      await markComplete(domain, pdfPath);

      console.log('COMPLETE:', domain);

    } catch (error) {

      console.log(
        'ERROR:',
        domain || 'QUEUE',
        error.message
      );

      if (domain) {
        await markError(domain, error.message);
        continue;
      }

      break;
    }
  }

  console.log('');
  console.log('QUEUE FINISHED');

  await context.close();

})();