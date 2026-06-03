import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure().errorText));

  console.log('Navigating to http://localhost:5174 ...');
  await page.goto('http://localhost:5174', { waitUntil: 'networkidle0' });
  
  console.log('Clicking a host card to select it...');
  // Wait for connections to load
  await page.waitForSelector('.host-card', { timeout: 5000 }).catch(() => console.log("No host card found"));
  
  const hostCards = await page.$$('.host-card');
  if (hostCards.length > 0) {
    await hostCards[0].click();
    console.log('Clicked host card');
    
    await new Promise(r => setTimeout(r, 500));
    
    console.log('Clicking Connect button...');
    const connectBtn = await page.$('.connect-button');
    if (connectBtn) {
      await connectBtn.click();
      console.log('Clicked Connect button');
      await new Promise(r => setTimeout(r, 2000));
    } else {
      console.log('No Connect button found');
    }
  }

  await browser.close();
})();
