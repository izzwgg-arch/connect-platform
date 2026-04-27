const path = require("node:path");

const standaloneOutput = process.env.NEXT_OUTPUT_STANDALONE === "1";

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  ...(standaloneOutput
    ? {
        output: "standalone",
        experimental: {
          outputFileTracingRoot: path.join(__dirname, "../.."),
        },
      }
    : {}),
};
