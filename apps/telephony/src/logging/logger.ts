import pino from "pino";
import { env } from "../config/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  redact: {
    paths: [
      "ami_password",
      "ari_password",
      "password",
      "secret",
      "AMI_PASSWORD",
      "ARI_PASSWORD",
      "JWT_SECRET",
    ],
    censor: "[REDACTED]",
  },
});

export function childLogger(name: string) {
  return logger.child({ component: name });
}
