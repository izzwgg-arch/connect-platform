#!/usr/bin/env node
/**
 * Generates a PKCS12 keystore for Android APK signing using node-forge.
 * Outputs: connect-release.keystore (PKCS12) + prints credentials.json payload.
 */
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const ALIAS = 'connect-mobile';
const PASSWORD = 'Connect2026!';
const YEARS_VALID = 25;
const OUT_PATH = path.join(__dirname, '..', 'connect-release.keystore');

console.log('Generating 2048-bit RSA key pair...');

const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
const cert = forge.pki.createCertificate();

cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + YEARS_VALID);

const attrs = [
  { name: 'commonName', value: 'Connect Communications' },
  { name: 'organizationName', value: 'Connect' },
  { shortName: 'OU', value: 'Mobile' },
  { name: 'localityName', value: 'New York' },
  { shortName: 'ST', value: 'NY' },
  { name: 'countryName', value: 'US' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: 'basicConstraints', cA: true },
  { name: 'keyUsage', keyCertSign: true, digitalSignature: true, nonRepudiation: true, keyEncipherment: true, dataEncipherment: true },
]);

cert.sign(keys.privateKey, forge.md.sha256.create());

console.log('Certificate generated. Creating PKCS12 keystore...');

const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
  keys.privateKey,
  [cert],
  PASSWORD,
  {
    algorithm: '3des',
    friendlyName: ALIAS,
    generateLocalKeyId: true,
  }
);

const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
const p12Buffer = Buffer.from(p12Der, 'binary');

fs.writeFileSync(OUT_PATH, p12Buffer);
console.log(`\nKeystore written to: ${OUT_PATH}`);
console.log(`Size: ${p12Buffer.length} bytes`);

const b64 = p12Buffer.toString('base64');

const credentials = {
  android: {
    keystore: {
      keystorePassword: PASSWORD,
      keyAlias: ALIAS,
      keyPassword: PASSWORD,
      keystoreEncoded: b64,
    },
  },
};

const credPath = path.join(__dirname, '..', 'credentials.json');
fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2));
console.log(`\ncredentials.json written to: ${credPath}`);
console.log('\n--- credentials summary ---');
console.log(`Alias:    ${ALIAS}`);
console.log(`Password: ${PASSWORD}`);
console.log(`Valid:    ${YEARS_VALID} years`);
console.log(`B64 len:  ${b64.length} chars`);
console.log('\nDone. Ready for EAS build.');
