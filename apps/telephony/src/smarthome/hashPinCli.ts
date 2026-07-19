// Generate a scrypt PIN hash for the smart-home IVR config file.
// Usage: tsx src/smarthome/hashPinCli.ts 1234

import { hashPin } from "./pinHash";

const pin = process.argv[2];
if (!pin || !/^\d{4,10}$/.test(pin)) {
  console.error("Usage: tsx src/smarthome/hashPinCli.ts <4-10 digit PIN>");
  process.exit(1);
}
console.log(hashPin(pin));
