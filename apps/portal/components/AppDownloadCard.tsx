"use client";

import { useEffect, useState } from "react";

function initialAndroidDownloadPageUrl(): string {
  const baked = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (baked) return `${baked}/mobile/android/download`;
  return "https://app.connectcomunications.com/api/mobile/android/download";
}

export function AppDownloadCard({
  title,
  description,
  variant = "generic",
}: {
  title: string;
  description: string;
  /** `mobile` shows a working link to the API-hosted Android download page. */
  variant?: "generic" | "mobile";
}) {
  const [androidPageUrl, setAndroidPageUrl] = useState(initialAndroidDownloadPageUrl);

  useEffect(() => {
    if ((process.env.NEXT_PUBLIC_API_URL || "").trim()) return;
    setAndroidPageUrl(`${window.location.origin.replace(/\/$/, "")}/api/mobile/android/download`);
  }, []);

  return (
    <div className="panel">
      <h3>{title}</h3>
      <p className="muted">{description}</p>
      <div className="row-actions">
        {variant === "mobile" ? (
          <a className="btn" href={androidPageUrl} target="_blank" rel="noopener noreferrer">
            Download Android APK
          </a>
        ) : (
          <button type="button" className="btn" disabled>
            Download APK
          </button>
        )}
        <button type="button" className="btn ghost" disabled>
          Open App Store
        </button>
      </div>
    </div>
  );
}
