const fs = require('fs');
const path = require('path');

const MAX_LOGO_BYTES = 500 * 1024;

function getAppUrl() {
  return (
    String(process.env.NEXT_PUBLIC_APP_URL || '').trim() ||
    String(process.env.APP_URL || '').trim() ||
    'https://app.trimprony.com'
  );
}

function extractUploadsPath(url) {
  const cleaned = url.trim();
  if (cleaned.startsWith('/uploads/')) return cleaned;
  try {
    const appUrl = getAppUrl().replace(/\/$/, '');
    if (cleaned.startsWith(appUrl + '/uploads/')) {
      return cleaned.slice(appUrl.length);
    }
    const parsed = new URL(cleaned);
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname;
    }
  } catch {}
  return null;
}

async function readLocalFile(uploadsPath) {
  try {
    const cwd = process.cwd();
    const filePath = path.join(cwd, 'public', uploadsPath);
    console.log('  Attempting to read:', filePath);
    return await fs.promises.readFile(filePath);
  } catch (e) {
    console.log('  Read error:', e.message);
    return null;
  }
}

async function main() {
  const testUrl = 'https://app.trimprony.com/uploads/cmkflk5ss00324egepjquq3pn/db12f06e-6a8b-44bb-90fa-f7f1bee5cfd1.png';
  const rawPath = '/uploads/cmkflk5ss00324egepjquq3pn/db12f06e-6a8b-44bb-90fa-f7f1bee5cfd1.png';
  
  console.log('APP URL:', getAppUrl());
  console.log('CWD:', process.cwd());
  
  console.log('\nTest 1: Full URL');
  const extracted1 = extractUploadsPath(testUrl);
  console.log('  extractUploadsPath result:', extracted1);
  if (extracted1) {
    const buf = await readLocalFile(extracted1);
    console.log('  File read:', buf ? `${buf.byteLength} bytes` : 'FAILED');
  }
  
  console.log('\nTest 2: Raw path');
  const extracted2 = extractUploadsPath(rawPath);
  console.log('  extractUploadsPath result:', extracted2);
  if (extracted2) {
    const buf = await readLocalFile(extracted2);
    console.log('  File read:', buf ? `${buf.byteLength} bytes` : 'FAILED');
  }
}

main();
