# OutdoorsOAV (OpenAI Version)

What if the expensive parts of the pipeline didn't need to be expensive?

This version uses **OpenAI Codex CLI** as the AI backend. Users sign in with their ChatGPT account — no API keys needed.

**Phase A -- Classification:** TF-IDF + Logistic Regression. Trained on accumulated task data. Tells the system what kind of request it's looking at. ~80ms.

**Phase B -- Memory retrieval:** TF-IDF keyword matching against stored knowledge. Finds relevant context without an API call. ~20ms.

**Phase C onward:** Codex handles execution -- the part that actually requires reasoning. Uses gpt-5.4 by default.

The ML models run in a persistent Python subprocess that stays warm between requests. Communication is newline-delimited JSON over stdin/stdout. No HTTP overhead, no cold starts, no serialization libraries. Just pipes.

```
outdoorsv4/ml/          training scripts, models, inference server
outdoorsv4/ml/models/   serialized TF-IDF vectorizers + classifiers
```

The routine work (classification, retrieval) doesn't need frontier models. Save those for where they matter. Two API calls became two local inferences -- faster, cheaper, and honestly more reliable for these specific tasks.

## Setup

Prerequisites: Node.js 18+, Python 3.9+, [Codex CLI](https://github.com/openai/codex) (`npm i -g @openai/codex`)

```bash
node setup.js
cd outdoorsv1/backend && node src/index.js
```

The setup script walks you through everything interactively:

1. **Browser choice** -- Chrome or Edge. Creates a separate automation profile with your existing cookies/sessions copied over (required for Chrome 136+ CDP support).
2. **Google login** -- Opens the automation browser so you can sign in (or verify you're already signed in from copied cookies).
3. **Google Cloud OAuth** -- Guides you through creating OAuth credentials in Google Cloud Console so Outdoors can access Gmail, Calendar, Drive, etc.
4. **Codex login** -- Sign in with your ChatGPT account via `codex login`.
5. **Dependencies** -- Installs npm packages and Python ML dependencies automatically.
