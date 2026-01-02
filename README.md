# Qlik Cloud Webhook HMAC Verification

Cloudflare Worker that receives webhooks from Qlik Cloud, verifies them using HMAC-SHA256, and triggers GitHub Actions workflows to verify branch creation.

## Features

- Receives POST requests from Qlik Cloud webhooks
- Verifies webhook authenticity using HMAC-SHA256 signature verification
- Triggers GitHub Actions workflows via `repository_dispatch` API
- GitHub Action verifies branch existence and cleans up
- Deployed on Cloudflare Workers for global edge deployment

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

For local development, create a `.dev.vars` file in the project root (Wrangler automatically loads this):

```bash
QLIK_WEBHOOK_SECRET=your-webhook-secret-key
GITHUB_TOKEN=your-github-personal-access-token
GITHUB_REPO=owner/repo-name
```

**Note:** The `.dev.vars` file is gitignored and should not be committed to version control.

**GitHub Token Requirements:**
- Create a Personal Access Token (PAT) with `repo` scope
- Or use a GitHub App token with repository access
- The token needs permission to trigger `repository_dispatch` events

### 3. Set Cloudflare Secrets

For production deployment, set secrets using Wrangler. Since `wrangler` is installed as a dev dependency, use `npx`:

```bash
# Set the Qlik webhook secret
npx wrangler secret put QLIK_WEBHOOK_SECRET

# Set the GitHub token (with repo scope)
npx wrangler secret put GITHUB_TOKEN

# Set the GitHub repository (format: owner/repo)
npx wrangler secret put GITHUB_REPO
```

**Note:** Each command will prompt you to enter the secret value interactively. The secrets are stored securely in Cloudflare and are not visible in your code.

Alternatively, you can use environment variables in `wrangler.jsonc` for non-sensitive values.

### 4. Local Development

```bash
npm run dev
```

The worker will be available at `http://localhost:8787/webhook`

### 5. Deploy

```bash
npm run deploy
```

After deployment, your webhook endpoint will be available at:
`https://qlik-webhook.YOUR_SUBDOMAIN.workers.dev/webhook`

## Usage

### Webhook Endpoint

The worker accepts POST requests at `/webhook` with the following:

- **Header**: `qlik-signature` - HMAC-SHA256 signature of the request body
- **Body**: JSON payload from Qlik Cloud

### Response

- **200 OK**: Webhook verified and forwarded successfully
- **400 Bad Request**: Missing signature or payload
- **401 Unauthorized**: Invalid signature

### Example Response

```json
{
  "success": true,
  "verified": true,
  "forwarded": true
}
```

## How It Works

1. Qlik Cloud sends a POST request to the worker's `/webhook` endpoint
2. The worker extracts the `qlik-signature` header and the raw request body
3. It computes an HMAC-SHA256 signature using the secret key
4. If signatures match, the webhook is verified as authentic
5. The worker triggers a GitHub Actions workflow via `repository_dispatch` API
6. The GitHub Action receives the webhook payload and verification status
7. The action checks for a branch matching the `id` from the webhook body
8. If the branch exists, it's deleted; if not, the workflow fails
9. The worker returns a success response

## Security

- HMAC verification ensures webhooks are authentic and haven't been tampered with
- Secrets are stored securely using Cloudflare Workers secrets
- The raw request body is used for signature verification to prevent tampering

## Testing

```bash
npm test
```

## Test Solution: End-to-End Webhook Verification

This section documents the complete test solution for verifying the webhook integration between Qlik Cloud, Cloudflare Worker, and GitHub Actions.

### Overview

The test solution verifies the entire webhook flow by:
1. Creating a branch in the repository via Qlik Cloud automation
2. Sending a webhook when the automation finishes
3. Verifying the webhook signature in the Cloudflare Worker
4. Triggering a GitHub Action that checks for the branch
5. Cleaning up the branch after verification

### Prerequisites

1. **Qlik Cloud Tenant** with:
   - Access to create automations
   - GitHub Connector configured and authenticated
   - Webhook configured to send automation finished events

2. **Cloudflare Worker** deployed with:
   - `QLIK_WEBHOOK_SECRET` secret configured
   - `GITHUB_TOKEN` secret configured (with `repo` scope)
   - `GITHUB_REPO` secret configured (format: `owner/repo`)

3. **GitHub Repository** with:
   - GitHub Actions enabled
   - The workflow file (`.github/workflows/webhook-branch-check.yml`) committed

### Test Flow

#### Step 1: Configure Qlik Cloud Webhook

1. In your Qlik Cloud tenant, navigate to **Webhooks** settings
2. Create a new webhook with the following configuration:
   - **URL**: `https://qlik-webhook.YOUR_SUBDOMAIN.workers.dev/webhook`
   - **Events**: Select only **Automation Finished** events
   - **Secret Key**: Use the same value as `QLIK_WEBHOOK_SECRET` in your Cloudflare Worker
   - **Method**: POST
   - **Content Type**: application/json

#### Step 2: Create Qlik Cloud Automation

1. In Qlik Cloud, create a new **Automation**
2. Add a **GitHub Connector** block to the automation
3. Configure the GitHub Connector block to:
   - **Action**: Create Branch
   - **Repository**: Select this repository (or enter `owner/repo`)
   - **Branch Name**: Use a dynamic value that will be unique (e.g., use the automation ID or a timestamp)
   - **Base Branch**: `main` (or your default branch)

4. **Important**: The branch name should match the `id` field that will be in the webhook payload when the automation finishes. You may need to:
   - Store the branch name/ID in a variable
   - Ensure the webhook payload includes this ID in the `id` field

5. Save and activate the automation

#### Step 3: Run the Automation

1. Execute the automation in Qlik Cloud
2. The automation will:
   - Create a branch in the GitHub repository using the GitHub Connector
   - Complete and trigger the "Automation Finished" event
   - Send a webhook to the Cloudflare Worker

#### Step 4: Webhook Processing

1. **Cloudflare Worker** receives the webhook:
   - Extracts the `qlik-signature` header
   - Verifies the HMAC-SHA256 signature
   - If valid, proceeds to forward the webhook

2. **Cloudflare Worker** triggers GitHub Actions:
   - Calls GitHub API `repository_dispatch` endpoint
   - Sends the original webhook body and verification status
   - Event type: `qlik-webhook`

#### Step 5: GitHub Action Execution

1. **GitHub Action** is triggered:
   - Receives the webhook payload via `repository_dispatch`
   - Extracts the `id` field from the webhook body
   - Checks if a branch with that name exists in the repository

2. **Branch Verification**:
   - ✅ **Success**: If branch exists → Delete the branch → Workflow succeeds
   - ❌ **Failure**: If branch does not exist → Workflow fails

3. **Cleanup**:
   - The branch is automatically deleted after verification (if it existed)

### Expected Results

#### Successful Test

1. Automation creates branch (e.g., `automation-12345`)
2. Webhook sent to Cloudflare Worker with `id: "automation-12345"`
3. Worker verifies signature ✓
4. Worker triggers GitHub Action ✓
5. GitHub Action finds branch `automation-12345` ✓
6. Branch deleted ✓
7. Workflow completes successfully ✓

#### Failed Test (Branch Not Found)

1. Automation creates branch (e.g., `automation-12345`)
2. Webhook sent with different `id` (e.g., `id: "different-id"`)
3. Worker verifies signature ✓
4. Worker triggers GitHub Action ✓
5. GitHub Action looks for branch `different-id` ✗
6. Branch not found → Workflow fails ✗

### Webhook Payload Structure

The webhook from Qlik Cloud should include an `id` field in the body. Example:

```json
{
  "type": "automation.finished",
  "id": "automation-12345",
  "timestamp": "2024-01-01T12:00:00Z",
  "data": {
    "automationId": "automation-12345",
    "status": "completed"
  }
}
```

The GitHub Action will look for a branch named `automation-12345` (the value of the `id` field).

### Troubleshooting

1. **Webhook not received**:
   - Check Cloudflare Worker logs
   - Verify webhook URL is correct
   - Check Qlik Cloud webhook configuration

2. **Signature verification fails**:
   - Ensure `QLIK_WEBHOOK_SECRET` matches the secret in Qlik Cloud
   - Verify the raw body is used for HMAC computation

3. **GitHub Action not triggered**:
   - Check `GITHUB_TOKEN` has `repo` scope
   - Verify `GITHUB_REPO` format is `owner/repo`
   - Check GitHub API rate limits

4. **Branch not found**:
   - Verify the `id` in webhook matches the branch name
   - Check branch was actually created
   - Review GitHub Action logs for details

### Monitoring

- **Cloudflare Worker Logs**: Available in Cloudflare Dashboard
- **GitHub Actions Logs**: Available in the Actions tab of the repository
- **Qlik Cloud Logs**: Available in Qlik Cloud monitoring

This test solution provides end-to-end verification of the webhook integration, ensuring that webhooks are properly verified and that the GitHub Actions workflow correctly processes the automation events.
