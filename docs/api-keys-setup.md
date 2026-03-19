# API Keys & OAuth Setup

This guide walks you through obtaining API keys for each supported LLM provider and setting up Google OAuth for Workspace integration.

---

## LLM Provider API Keys

You need at least **one** provider API key to use ClawBuddy. Add it to your `.env` file.

### OpenAI

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Sign up or log in
3. Click **Create new secret key**
4. Name it (e.g., `clawbuddy`)
5. Copy the key immediately — it's only shown once

```env
AI_PROVIDER="openai"
EMBEDDING_PROVIDER="openai"
OPENAI_API_KEY="sk-..."
```

> OpenAI provides both chat models (GPT-5.4, GPT-5, GPT-4.1, O3) and embedding models (text-embedding-3-small/large).

### Anthropic (Claude)

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Navigate to **API Keys** in the sidebar
4. Click **Create Key**
5. Copy the key immediately

```env
AI_PROVIDER="claude"
ANTHROPIC_API_KEY="sk-ant-..."
```

> Claude provides chat models only (Opus 4.6, Sonnet 4.6, Haiku 4.5). You'll need a separate embedding provider — set `EMBEDDING_PROVIDER="openai"` or `"gemini"` and add the corresponding API key.

### Google Gemini

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with your Google account
3. Click **Get API key** in the sidebar
4. Click **Create API key**
5. Copy the key

```env
AI_PROVIDER="gemini"
EMBEDDING_PROVIDER="gemini"
GEMINI_API_KEY="AIza..."
```

> Gemini provides both chat models (Gemini 3.1 Pro, 3 Flash, 2.5 Pro/Flash) and embedding models (gemini-embedding-001, gemini-embedding-002).

### Using Multiple Providers

You can mix providers — for example, use Claude for chat and OpenAI for embeddings:

```env
AI_PROVIDER="claude"
EMBEDDING_PROVIDER="openai"
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-..."
```

---

## Google OAuth Setup (Google Workspace)

Google OAuth is **optional** — only needed if you want the Google Workspace capability (Gmail, Calendar, Drive, Tasks, Docs, Sheets, Slides).

### Step 1: Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown at the top and select **New Project**
3. Name it (e.g., `ClawBuddy`) and click **Create**
4. Select your new project from the dropdown

### Step 2: Enable APIs

Go to **APIs & Services > Library** and enable these APIs:

- **Gmail API**
- **Google Calendar API**
- **Google Drive API**

Search for each one and click **Enable**.

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. Select **External** (or Internal if using Google Workspace org)
3. Fill in:
   - **App name**: `ClawBuddy`
   - **User support email**: your email
   - **Developer contact**: your email
4. Click **Save and Continue**
5. On the **Scopes** step, click **Add or Remove Scopes** and add:
   - `https://mail.google.com/`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/userinfo.email`
6. Click **Save and Continue**
7. On **Test users**, add your Google email address
8. Click **Save and Continue**

> While in "Testing" mode, only the test users you add can authorize. To allow any Google account, publish the app (Google may require verification for sensitive scopes).

### Step 4: Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Select **Web application**
4. Name it (e.g., `ClawBuddy`)
5. Under **Authorized redirect URIs**, add:
   ```
   http://localhost:4321/api/oauth/google/callback
   ```
   If you're running ClawBuddy on a different URL, replace `http://localhost:4321` with your `APP_URL`.
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

### Step 5: Add to .env

```env
GOOGLE_CLIENT_ID="123456789-abc.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-..."
```

If your ClawBuddy is not on `localhost:4321`, also set:

```env
APP_URL="https://your-domain.com"
```

### Step 6: Connect in ClawBuddy

1. Open ClawBuddy and go to **Settings > Capabilities**
2. Enable the **Google Workspace** capability
3. Click **Connect with Google**
4. Authorize with your Google account
5. Done — the AI can now access your Gmail, Calendar, and Drive

---

## Environment Variables Reference

| Variable               | Required             | Description                                           |
| ---------------------- | -------------------- | ----------------------------------------------------- |
| `AI_PROVIDER`          | Yes                  | Chat model provider: `openai`, `claude`, or `gemini`  |
| `EMBEDDING_PROVIDER`   | Yes                  | Embedding provider: `openai` or `gemini`              |
| `OPENAI_API_KEY`       | If using OpenAI      | OpenAI API key                                        |
| `ANTHROPIC_API_KEY`    | If using Claude      | Anthropic API key                                     |
| `GEMINI_API_KEY`       | If using Gemini      | Google AI Studio API key                              |
| `GOOGLE_CLIENT_ID`     | For Google Workspace | OAuth client ID                                       |
| `GOOGLE_CLIENT_SECRET` | For Google Workspace | OAuth client secret                                   |
| `APP_URL`              | If not localhost     | Your ClawBuddy URL (default: `http://localhost:4321`) |
| `ENCRYPTION_SECRET`    | Yes                  | Auto-generated by bootstrap.sh                        |
| `DEBUG_AGENT`          | No                   | Set to `1` for verbose agent logging                  |
