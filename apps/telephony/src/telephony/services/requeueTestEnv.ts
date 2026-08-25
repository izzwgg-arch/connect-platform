// Side-effect module: seed the minimal env required by src/config/env.ts so
// tests that import TelephonyService (which transitively loads env) can run
// without a live AMI/ARI configuration. Import this FIRST in such tests.
process.env.AMI_USERNAME ??= "test";
process.env.AMI_PASSWORD ??= "test";
process.env.ARI_BASE_URL ??= "http://127.0.0.1:8088";
process.env.ARI_USERNAME ??= "test";
process.env.ARI_PASSWORD ??= "test";
// env.ts enforces >= 32 chars since d21fd166 — a shorter default fails every
// TelephonyService-importing test in a shell without its own JWT_SECRET.
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-0123";
