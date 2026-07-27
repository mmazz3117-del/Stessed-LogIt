# Stressed LogIt v1.2 — Cozy Header + Patterns

This package builds on v1.1 and preserves the Firebase project, Google Authentication, Firestore collection path, and secure OpenAI Cloud Function setup already prepared for Stressed LogIt.

## What is new

- New full-width colored brand header with an embedded SVG mark. The header no longer depends on an external image, so it displays when `index.html` is opened locally.
- A **Working list** with search, status, category, date-range, and sort controls.
- Entry statuses: **Working on it**, **Set aside**, and **Resolved**.
- A **Patterns** view with adjustable date range, chart point grouping, category, and status.
- Stress-over-time trend chart.
- Average stress by category chart.
- Entries-by-weekday chart.
- Local possible-pattern summaries.
- Local cross-referencing of entries with similar wording or shared tags.

## Your existing Firebase setup remains intact

The app still uses:

`users/{your-uid}/entries/{entryId}`

No replacement Firestore rules are included. Existing entries without a `status` field are automatically treated as **Working on it**. There is no required database migration.

New entries may include these additional optional fields:

- `status`: `active`, `parked`, or `resolved`
- `updatedAt`
- `resolvedAt` when marked resolved

Your existing user-specific rules should continue to work as long as they permit the signed-in user to write documents within their own `entries` subcollection, as described in your completed setup.

## Preview locally first

1. Extract the entire package.
2. Keep `index.html`, `manifest.webmanifest`, `assets`, and `functions` together.
3. Open `index.html`.

The main header mark is embedded directly in the page. The browser tab and installed-app icons still use the included `assets` folder.

Google sign-in may not work reliably from a `file://` local preview. That does not indicate a Firebase problem. Test sign-in from the authorized GitHub Pages address after uploading.

## Files to upload to the main GitHub repository

Replace or upload at the repository root:

- `index.html`
- `manifest.webmanifest`
- the complete `assets` folder

The `assets` files are included so the package remains complete, even though the main header now uses an inline mark.

## Secure OpenAI function

The `functions` folder, `firebase.json`, and `.firebaserc` are the same secure approach prepared for v1.1. The OpenAI key is not placed in `index.html` or GitHub.

If the function has not been deployed yet, run from the main local Stressed LogIt repository folder:

```bash
firebase login
firebase use stressed-logit
firebase functions:secrets:set OPENAI_API_KEY
cd functions
npm install
npm run lint
cd ..
firebase deploy --only functions
```

Do not deploy Firestore rules as part of this update.

## Recommended order

1. Preview `index.html` locally.
2. Confirm the header, Working list, filters, and Patterns layout.
3. Deploy the Firebase function if it has not been deployed.
4. Upload the root web files to GitHub.
5. Test Google sign-in, a new entry, status changes, patterns, and AI support on the live GitHub Pages address.

## Pattern privacy

Charts, possible-pattern notes, and related-entry comparisons are calculated in the browser from the entries already loaded for the signed-in user. Those features do not send journal text to OpenAI. Journal text is sent to the secure function only when the user explicitly asks for an AI suggestion or conversation.
