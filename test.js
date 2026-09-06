const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const QUEUE_BASE = 'https://promptdash-runner.lovable.app';
const WORKER_SECRET = process.env.PROMPTWATCH_WORKER_SECRET;

const PROMPTWATCH_URL = 'https://promptwatch.com/ai-visibility-report';
const PDF_FOLDER = '/tmp/promptwatch-pdfs';

if (!WORKER_SECRET) {
  throw new Error('PROMPTWATCH_WORKER_SECRET is missing');
}

if (!fs.existsSync(PDF_FOLDER)) {
  fs.mkdirSync(PDF_FOLDER, { recursive: true });
}

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
    const text = await response.text();
    throw new Error(`GET NEXT failed: ${response.status} ${text}`);
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  const data = JSON.parse(text);

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
  let context;

  try {
    console.log('STARTING CHROMIUM');

    context = await chromium.launchPersistentContext(
      '/tmp/promptwatch-profile',
      {
        headless: true
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
          console.log(
            'NO URLS WAITING - CHECKING AGAIN IN 10 SECONDS'
          );
          await page.waitForTimeout(10000);
          continue;
        }

        domain = job.url;

        console.log('STARTING:', domain);

        await page.goto(PROMPTWATCH_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
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

        const safeFilename = domain.replace(
          /[^a-zA-Z0-9.-]/g,
          '_'
        );

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

        await new Promise(resolve =>
          setTimeout(resolve, 10000)
        );
      }
    }

  } catch (error) {
    console.error('WORKER FAILED:', error);
    process.exitCode = 1;

  } finally {
    if (context) {
      await context.close();
    }
  }
})();
