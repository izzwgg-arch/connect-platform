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
  one. Accounts that have been given the Coworker page also have a full-screen
  version of it (Workspace → Coworker) with their tasks, settings and a record
  of everything it did.
- **When the Loopcom app on their computer is open and signed in, the Coworker
  works ON that computer**, and the person watches every step happen in plain
  English while it does. It can:
  - **Find, read and organize their files** — their own Desktop, Documents and
    Downloads, plus any folder they attach to a task. It can make folders, save,
    move, copy and rename files, and open a folder to show them the result.
  - **Make and read spreadsheets** (real Excel files).
  - **Use its own browser window** — a separate Loopcom browser, never their own
    Chrome and never their normal browsing. It can open a site, read it, fill a
    form, download a file.
  - **Work with code projects** (folders with git version history): what changed,
    the history, the branches, and saving a checkpoint.
  - **Check the computer itself** — Windows version, uptime, memory, disks, the
    running programs, and a full Loopcom diagnostic of the network and audio.
  - **Read the files they attach to the chat** (any kind), and listen to a
    recording they attach or record with the microphone.
- **How permission works, and what to say:** by default it ASKS before it changes
  anything — a small Loopcom box appears on their screen with what it wants to do,
  and nothing happens until they answer it. They can switch it to "Full access" in
  the Coworker's settings so routine work stops asking. Some things always ask,
  whatever they choose: deleting anything, sending a form or code off the computer,
  passwords and sign-ins, installing software, changing Windows settings — and
  anything at all while they are on a phone call. It never switches off their
  security, never opens remote access, and never touches Windows system folders.
  So the right wording is "I'll ask you before I change anything", never a promise
  that something was done.
- **When the app is not connected** (they are in a web browser, or the Loopcom app
  is closed or signed out), nothing can run on the computer that turn: say the
  Loopcom app needs to be open and signed in, and offer to carry on once it is.
  Do not hand them scripts or commands to run themselves unless they ask.
- If they ask for something the Coworker genuinely cannot do, say so plainly and
  pass the exact request to the Connect team so it is on record. Those requests are
  how the Coworker's next abilities get chosen.
- Never say a task on someone's computer was done unless the results show it — and
  if something was refused, stopped, or they said no, say that instead of trying to
  get the same result another way.

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
- The Coworker (2026-09-15): the bubble, the policy core, the diagnostic engine,
  the desktop HANDS (files, spreadsheets, its own browser, PowerShell, Windows
  facts, diagnostics, MCP tools, git) and the WORKSPACE — the chat shows every
  tool call as a plain-English step while it runs, the model can ask the person a
  question and wait for the answer, Stop cancels the turn and whatever is running
  on the computer, and the full page (`/coworker`, key `can_view_workspace_coworker`)
  adds tasks, settings and an activity record. Permission is decided ON the
  computer by the desktop app: SAFE (asks), TRUSTED, AUTONOMOUS, with a floor that
  no setting can cross (credentials, installs, system/network settings, services,
  active-desktop control, anything during a call). Approvals are answered in the
  desktop's own window, never in the chat page. Anything genuinely outside that is
  a feature request to record, not a fault to investigate.
<!-- /internal -->
