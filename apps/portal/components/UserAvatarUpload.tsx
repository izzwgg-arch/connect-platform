"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, X } from "lucide-react";
import { apiUploadUserAvatar, apiDeleteUserAvatar, ApiError } from "../services/apiClient";

type Props = {
  name: string;
  avatarUrl?: string | null;
  /** px — default 36 */
  size?: number;
  /** Show camera overlay on hover and allow clicking to upload. Default false. */
  editable?: boolean;
  onUploaded?: (url: string | null) => void;
  className?: string;
};

export function UserAvatarUpload({
  name,
  avatarUrl,
  size = 36,
  editable = false,
  onUploaded,
  className = "",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A stored avatarUrl whose file is gone renders as a broken-image glyph,
  // which reads as "the app is broken" rather than "no photo yet". Fall back to
  // the initials instead. This is a real state: avatars used to be written to
  // <cwd>/data, which no volume covered, so every api deploy destroyed the file
  // while the DB kept avatarStorageKey and avatarUrl pointing at it.
  // Keyed to the URL that failed, not a bare boolean, so uploading a replacement
  // renders it: the upload route returns /api/me/avatar?v=<sha>, a new URL per file.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!avatarUrl && failedUrl !== avatarUrl;

  const initials = name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "U";

  const handleClick = () => {
    if (!editable || loading) return;
    inputRef.current?.click();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") handleClick();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("Image must be under 2 MB");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Only JPEG, PNG, or WebP");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await apiUploadUserAvatar(file);
      onUploaded?.(res.avatarUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setLoading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    try {
      await apiDeleteUserAvatar();
      onUploaded?.(null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={`uau-wrap ${editable ? "uau-editable" : ""} ${className}`}
      style={{ "--uau-size": `${size}px` } as React.CSSProperties}
      onClick={editable ? handleClick : undefined}
      role={editable ? "button" : undefined}
      tabIndex={editable ? 0 : undefined}
      onKeyDown={editable ? handleKeyDown : undefined}
      aria-label={editable ? "Change profile photo" : undefined}
    >
      {showImage ? (
        <img
          src={avatarUrl as string}
          alt={name}
          className="uau-img"
          draggable={false}
          onError={() => setFailedUrl(avatarUrl ?? null)}
        />
      ) : (
        <span className="uau-initials" aria-hidden>{initials}</span>
      )}

      {loading && (
        <span className="uau-overlay uau-loading">
          <Loader2 size={Math.max(12, size * 0.38)} className="uau-spin" aria-hidden />
        </span>
      )}

      {editable && !loading && (
        <span className="uau-overlay uau-hover-overlay" aria-hidden>
          <Camera size={Math.max(10, size * 0.35)} />
        </span>
      )}

      {editable && avatarUrl && !loading && (
        <button
          className="uau-remove"
          type="button"
          onClick={handleRemove}
          title="Remove photo"
          aria-label="Remove profile photo"
        >
          <X size={10} />
        </button>
      )}

      {editable && (
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      )}

      {error && <div className="uau-error">{error}</div>}
    </div>
  );
}
