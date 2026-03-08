"use client";

const categories = [
  "Profile",
  "Presence & Status",
  "Call Forwarding",
  "Greetings / Voicemail",
  "Devices / Audio / Video",
  "BLFs / Speed Dials",
  "Notifications",
  "Chat & SMS Preferences",
  "Security",
  "Mobile App Pairing",
  "Integrations",
  "Appearance",
  "Office Hours"
];

export function SettingsNav() {
  return (
    <aside className="settings-nav">
      {categories.map((cat) => (
        <button key={cat} className="settings-nav-item">
          {cat}
        </button>
      ))}
    </aside>
  );
}
