import { ScopedActionButton } from "./ScopedActionButton";

export function AudioPlayerRow({ title, from, duration }: { title: string; from: string; duration: string }) {
  return (
    <div className="audio-row">
      <div>
        <strong>{title}</strong>
        <div className="meta">{from}</div>
      </div>
      <div className="meta">{duration}</div>
      <audio controls preload="none" />
      <ScopedActionButton className="btn ghost">Call Back</ScopedActionButton>
      <ScopedActionButton className="btn ghost" allowInGlobal>Download</ScopedActionButton>
      <ScopedActionButton className="btn danger">Delete</ScopedActionButton>
    </div>
  );
}
