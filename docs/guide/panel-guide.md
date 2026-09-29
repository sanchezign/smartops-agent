# SmartOps panel guide

For the business owner and the team who use the panel every day. It explains what each screen
shows and what to do in it. No technical knowledge is needed. (Versión en español:
[guia-del-panel.md](guia-del-panel.md).)

## What SmartOps does for you

Your suppliers send price lists over WhatsApp: text, photos of printed lists, PDFs,
spreadsheets, voice notes. SmartOps reads them and updates your catalog by itself. When it is not
sure about something, it does not guess: it leaves it in **Reviews** for a person to decide.
Customers' questions and orders are passed on to the team, and the team gets a short WhatsApp
summary instead of one message per event.

## Signing in

![The sign-in screen](media-en/login.webp)

- Sign in with your email and password. Passwords are long phrases (at least 15 characters);
  after several failed attempts the account is locked for a while, and an administrator can
  unlock it.
- **Language:** choose English or Español in the selector (top right, or in your account menu on
  a phone). The panel remembers your choice on every device.
- **Theme:** light, dark or the device's, from your account menu.
- **Sign out everywhere** (account menu) closes your sessions on every device, for example after
  losing a phone.

## Home

![The home screen](media-en/dashboard.webp)

- The top row is what needs a person now: **pending reviews**, **open alerts**, **chats handled
  by a person** and **errors**. Click a card to go there.
- **Resolved without a person** is the share of processed messages that needed nobody.
- **Filtered without AI** counts messages (greetings, stickers, customers' chat) that never cost
  anything, with the estimated saving.
- The charts show messages per day and the AI cost per day, with the daily and total budgets.
- Switch between 7, 14 and 30 days at the top right.

## Reviews

![The review queue](media-en/reviews.webp)

A review is a decision the system does not take alone. Nothing in a pending review has been
applied to the catalog yet. Filter by type (whole lists, products, catalog) and by status.

**A product line** (for example, an unusual price change):

![A product review](media-en/review-line.webp)

1. Read what the list says and the original message (the link opens the conversation).
2. Choose which product it is, or "It's a new product".
3. Check or correct the price, then **Apply price**. Type prices without a thousands separator
   (1850 or 1850.50): an ambiguous "1,850" is refused on purpose.
4. **Reject** if it is wrong; you can leave a note for the team.

**A new spreadsheet format**: the first time a supplier sends a spreadsheet with a new layout,
you choose which price column goes into the catalog. Each option shows real values from the
file, and the suggested one is pre-selected. After that, spreadsheets with the same layout are read
by themselves, without AI and at no cost.

![Choosing the price column](media-en/review-columns.webp)

Other reviews you may see: "Is it this product?", a product missing from a full list ("Mark as
unavailable?"), an across-the-board change ("everything +8 %"), a change of VAT basis, and a
**suspicious message** that tries to give orders to the system (nothing was applied; read it
before processing it).

Operators resolve product lines. Reviews that affect a whole list or the whole catalog are for
administrators.

## Conversations

![The inbox](media-en/inbox.webp)

- Each chat shows who is answering: 🤖 **the bot answers**, 👤 **a person is handling it** (until
  a time), or ⛔ **opted out**.
- Search by name, supplier or phone, and filter by type.

![A conversation](media-en/chat.webp)

- **Reply as a person** from the box at the bottom. It is sent over WhatsApp as the company, and
  the bot pauses in that chat (by default for 2 hours after your last message). WhatsApp only
  allows free replies within 24 hours of the contact's last message; the panel tells you when
  the window is closed.
- **Pause the bot** (30 minutes, 2 hours, 8 hours or until you reactivate it) and **Reactivate
  the bot** at any time.
- A person's reply only pauses the automatic answers: the contact's price lists are still
  processed and the team still gets alerts.
- **Opt-outs:** if a contact writes BAJA or STOP, they stop receiving automatic messages. You can
  also record an opt-out by hand (menu ⋮). Only an administrator records an opt-in again. The
  list of opted-out contacts is under **Opted out**.

## Catalog

![A product's price history](media-en/product.webp)

- Every supplier's products with their last price and last change. Search by name or filter by
  supplier and availability.
- Open a product to see its price history: the chart and the list of changes, each with a link to
  the message that caused it.
- Administrators can **rename a supplier** (for example, when it was created with a WhatsApp
  name).

## Alerts

![Alerts](media-en/alerts.webp)

Large price increases, low stock, voice notes too long to transcribe, and integration errors.
Mark each one as **seen** once it is handled.

## Rules

![Rules](media-en/rules.webp)

How the system behaves, without touching code. Changes apply at once and are recorded. Only
administrators can change them.

- **Automatic replies:** the language of WhatsApp messages, the bot on or off, confirming to
  suppliers that their list arrived, and how long the bot stays paused after a person replies.
- **Business hours:** outside them, non-urgent WhatsApp summaries wait until opening time.
- **Prices:** from what percentage a change raises an alert, and above what increase or decrease
  a price waits for review; creating new products automatically.
- **WhatsApp alerts to the team:** who receives the summaries, how often, and the hourly limits.
- **Voice notes and opt-outs:** the longest voice note transcribed automatically, and the
  opt-out and opt-in words.

## Users (administrators)

![Users](media-en/users.webp)

- Create users as **operator** (reviews of product lines and conversations) or **administrator**
  (everything, including rules and users).
- Change roles, deactivate, set a new password, unlock, or close a user's sessions. Every change
  of role, deactivation or new password closes that user's sessions.
- Nobody can change their own role or deactivate themselves, and there is always at least one
  active administrator.

## The WhatsApp summary

The team receives one message per period (10 minutes by default) with what needs action: orders,
customers' questions, lists with large changes or pending reviews, and errors. The link at the
end opens the matching screens in the panel (you are asked to sign in first).

## What SmartOps never does

- It never invents a price or guesses a doubtful value: it asks in Reviews.
- It never applies instructions written inside a message or a file.
- It never writes to contacts who opted out, except the single confirmation.
- It never sends more than the limits you set in Rules.
