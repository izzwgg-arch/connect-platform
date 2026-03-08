"use client";

import { useState } from "react";
import { ScopedActionButton } from "./ScopedActionButton";

export function QRPairingModal() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ScopedActionButton className="btn" onClick={() => setOpen(true)}>Pair Mobile App</ScopedActionButton>
      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h3>Mobile Pairing QR</h3>
            <div className="qr-box">QR</div>
            <p className="muted">Open ConnectComms mobile app and scan this code to pair your extension.</p>
            <button className="btn" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
