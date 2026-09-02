---
title: How Connect works
scope: system
---

# How Connect works

Facts about the Connect phone platform that are true for every customer. The
assistant reads this before every conversation, alongside the one document
belonging to the company the person is from.

## What Connect is

Connect is a business phone service. Calls arrive on the company's phone
numbers, ring their phones — desk phones, the Connect app on a mobile, the
Connect app on a computer — and anything unanswered goes to voicemail. The same
account also carries texting, call history with recordings, and a contacts list.

## The apps people use

- **The web app** at app.connectcomunications.com — the full account: calls,
  voicemail, texting, contacts, settings.
- **The Windows app** — the same thing in a desktop window, plus a small dialer.
  It keeps whatever version was loaded when the window opened, so after an
  update someone may need to close the window fully and reopen it.
- **The phone app** on Android and iPhone — makes and takes calls on the
  company's extension.

If someone says a change they made is not showing, having them fully close and
reopen the app is a fair first thing to try, and often the whole answer.

## Calls

- An incoming call rings for about 15 seconds before it goes to voicemail.
  On a mobile phone, Connect wakes the app first, so a phone that was asleep
  still rings.
- A missed call and a voicemail are different things: a caller can hang up
  without leaving a message, and then there is a missed call and no voicemail.
- **Call recording is set per phone number, not per person.** If a company's
  calls are not being recorded, it is because recording is off on the route the
  call came in on — not because of anything the person did.
- A play button on an old call can turn out to have no recording behind it. The
  app now says so plainly instead of failing silently.

## Voicemail

- Voicemail-to-email comes from the phone system itself and sends the message as
  an attachment, from support@connectcomunications.com. It only happens for
  mailboxes that have an email address saved against them — a mailbox with no
  address recorded generates no email at all, silently.
- Voicemails also appear in the app whether or not email is switched on.
- A mailbox has a limit on how many messages it can hold. A very full mailbox
  eventually stops accepting new messages, and callers are then not recorded at
  all — worth flagging to the team long before it gets there.

## Texting

- Texting is per number, and has to be turned on for the account. Not every
  company has it.
- Texts sent to a company arrive in the app, and can be shared by a team or
  belong to one person, depending on how the account was set up.

## Phone menus ("press 1 for…")

- A menu answers with a greeting, then each key sends the caller somewhere: a
  person, a team of phones, a waiting line, a recorded message, voicemail, or an
  outside phone number.
- A company can have different menus for open hours and after hours, and the
  switch between them happens on a schedule.
- Changes to a menu take effect when they are published. A change that has not
  been published yet is not what callers hear.

## The Loopcom Coworker (the bubble on the Windows app)

- The Windows app can show a small round Loopcom bubble that floats above every
  other window. It is switched on from the tray icon ("Show Coworker Bubble"),
  it can be dragged anywhere, and one click opens this chat beside it. It is
  the same assistant as the one in the corner of every page — not a different
  one.
- What the Coworker can do today is exactly what this chat can do: answer
  questions, look things up on the account, and pass a request to the team.
- **The Coworker cannot yet do anything on the person's computer.** It cannot
  open, organize, move or change files, run programs, or change Windows
  settings — and nothing behind the assistant can do those either. When someone
  asks for that, the honest answer is that the Coworker cannot do it yet; do not
  hand them scripts or commands to run themselves unless they ask for that, and
  pass the exact request to the Connect team so it is on record. Those requests
  are how the Coworker's next abilities get chosen.
- Never say a task on someone's computer was done, started, or scheduled.
- The one thing the Windows app can already do on the computer is the desk
  phone setup wizard (Settings → Devices → Desk Phones, for accounts that have
  that permission), which finds the desk phones on the office network and
  points them at Connect.

## What the assistant can do itself

Some requests are carried out automatically the moment they are clearly worded:
turning Do Not Disturb on or off for an extension, changing hold music (for the
company or one extension, including "for 30 minutes" or "until 5pm"), and saying
which hold music is playing right now.

Everything else goes to the Connect team with the details already gathered. That
is not a brush-off: the request is written up with what has been checked and
what the fix would be, and it reaches a person immediately.

## Things that are true and often surprise people

- **Their internet filter is usually in the path.** Most Connect customers run
  filtered internet. It can make a phone appear to drop and reconnect
  repeatedly. This is worth knowing but is never something to blame the customer
  for.
- **A phone that shows "registered" is not proof the phone system can reach it.**
  If someone says it rang and never connected, that is a real and known failure
  shape, not the person misremembering.
- **A desk phone does not pick up a change until it fetches its settings.**
  Rebooting a desk phone does not always do that.
- The Connect server is in Europe, so there is a small unavoidable delay on
  every request. Pages loading a little slower than a local app is normal;
  pages taking many seconds is not.

<!-- internal -->
## Staff-only notes

These reach the escalation report, never a customer.

- Alert emails to the owner's inbox are muted at the send door. Escalations are
  the only channel that still reaches him — SMS plus email. Do not propose
  "we will alert you when…" as a fix; nothing will arrive.
- Voicemail-to-email is sent by Asterisk on the PBX, not by Connect. Connect's
  own voicemail sender has never been enabled. 58 mailboxes platform-wide have
  no email address saved, which is the real cause of nearly every "we stopped
  getting voicemail emails" report.
- One mailbox sends everything Connect sends, capped at 500 messages a day.
- Gesheft extension 101's mailbox is close to its 9,999-message limit; at the
  wall, callers stop being recorded entirely.
- Recording is `enablerecording` per inbound route on the PBX. Turning it on for
  a customer is a panel change and needs the owner.
- The assistant cannot change call routing, add users, or touch billing on its
  own. Anything of that kind must be proposed for approval, never promised.
- The Coworker (2026-09-02): the bubble, the policy core and the diagnostic
  engine exist; the desktop hands (files, programs, settings) and the approval
  screens do not. A customer asking the Coworker to act on their computer is a
  feature request to record, not a fault to investigate.
<!-- /internal -->
