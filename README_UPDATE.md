# Stressed LogIt v1.3 — Warmer AI + Model Choice

This update keeps the v1.2 journal, Firebase Authentication, Firestore paths, working list, charts, themes, icons, and existing OpenAI secret. It changes the AI conversation layer so it listens first and feels less rigid.

## What changed

- **Listen first** is the default conversation style.
- Responses reflect a specific personal detail before moving toward advice.
- The AI avoids worksheet language such as “Facts,” “Predictions,” and “Concrete steps” unless the user requests structure.
- Responses ask one natural follow-up question rather than giving a large plan immediately.
- Three conversation styles are available in Settings: **Listen first**, **Balanced**, and **Practical**.
- Three server-approved model choices are available in Settings:
  - **Thoughtful — GPT-5.1:** richest nuance, higher API-credit use.
  - **Balanced — GPT-5 mini:** recommended default.
  - **Quick — GPT-5 nano:** fastest and lowest credit use.
- Model and style choices are saved only in that device's browser.
- The Firebase function validates the selection against a fixed allow-list; the browser cannot request an arbitrary model.
- If Thoughtful or Quick is unavailable to the API project, the function safely falls back to Balanced.

## Important expectation

Changing models can affect nuance, speed, and cost, but the warmer result comes primarily from the revised conversation instructions. An API conversation will not be identical to a ChatGPT conversation because it does not have the same long-term context, tools, or chat history.

## Existing Firebase setup preserved

The app still uses:

`users/{your-uid}/entries/{entryId}`

No Firestore rules are included or changed. The existing `OPENAI_API_KEY` secret remains in Firebase Secret Manager. Do not create or paste a new key for this update.

## Firebase function update

The function source changed, so redeploy it before expecting the warmer replies or model selection to work.

From the extracted **Stressed_LogIt_v1_3_Warmer_AI_Model_Choice_GitHub_Package** folder in Cloud Shell:

```bash
nvm use 22
cd functions
npm install
npm run lint
cd ..
firebase use stressed-logit
firebase deploy --only functions
```

You do not need to run `firebase functions:secrets:set OPENAI_API_KEY` again.

## GitHub files to replace

At the repository root, replace:

- `index.html`
- `manifest.webmanifest`
- `README_UPDATE.md` (optional documentation)

Inside the existing `functions` folder, replace:

- `functions/index.js`
- `functions/package.json`

No icon changes were required. The included `assets` folder is unchanged and can remain as-is in GitHub.

## Recommended order

1. Deploy the updated Firebase function.
2. Replace the GitHub files.
3. Wait for GitHub Pages to publish.
4. Refresh the live app.
5. Open **Settings** and choose a conversation style and model.
6. Test **Talk it through** with a concern that has personal meaning.

## Privacy

The app sends the selected journal entry and current support conversation only when AI help is requested. Requests use the OpenAI Responses API with `store: false`. The journal log and pattern calculations continue to use the existing local/Firebase design.
