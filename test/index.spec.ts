import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Helper function to compute HMAC-SHA256 signature
async function computeHMAC(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
	return Array.from(new Uint8Array(signature))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

// Helper function to create a valid webhook payload with required structure
function createValidPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'automation.finished',
		data: {
			id: 'automation-run-12345',
			automation: {
				id: 'automation-12345',
			},
		},
		...overrides,
	};
}

// Helper function to create a valid webhook request
async function createWebhookRequest(
	payload: object,
	secret: string,
	url = 'https://example.com/webhook'
): Promise<Request> {
	const payloadString = JSON.stringify(payload);
	const signature = await computeHMAC(payloadString, secret);
	
	return new IncomingRequest(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'qlik-signature': signature,
		},
		body: payloadString,
	});
}

describe('Qlik Cloud Webhook Worker', () => {
	const testSecret = 'test-secret-key';
	const testEnv = {
		QLIK_WEBHOOK_SECRET: testSecret,
		GITHUB_TOKEN: 'test-github-token',
		GITHUB_REPO: 'owner/repo',
	} as Env;

	beforeEach(() => {
		// Reset fetch mocks before each test
		vi.restoreAllMocks();
	});

	describe('Route handling', () => {
		it('returns 404 for non-POST requests', async () => {
			const request = new IncomingRequest('https://example.com/webhook', {
				method: 'GET',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(404);
			expect(await response.text()).toBe('Not Found');
		});

		it('returns 404 for wrong path', async () => {
			const request = new IncomingRequest('https://example.com/other-path', {
				method: 'POST',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(404);
		});
	});

	describe('HMAC signature verification', () => {
		it('returns 400 when signature header is missing', async () => {
			const request = new IncomingRequest('https://example.com/webhook', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ type: 'test' }),
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
			const body = await response.json() as { error: string };
			expect(body.error).toBe('Missing signature or payload');
		});

		it('returns 401 when payload body is empty but signature is provided', async () => {
			const request = new IncomingRequest('https://example.com/webhook', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'qlik-signature': 'some-signature',
				},
				body: '',
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Empty body with signature will fail verification, returning 401
			expect(response.status).toBe(401);
			const body = await response.json() as { verified: boolean };
			expect(body.verified).toBe(false);
		});

		it('returns 401 when signature is invalid', async () => {
			const payload = createValidPayload();
			const request = new IncomingRequest('https://example.com/webhook', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'qlik-signature': 'invalid-signature',
				},
				body: JSON.stringify(payload),
			});

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(401);
			const body = await response.json() as { verified: boolean; error: string };
			expect(body.verified).toBe(false);
			expect(body.error).toBe('Invalid signature');
		});

		it('rejects signature computed with wrong secret', async () => {
			const payload = createValidPayload();
			// Create request with signature from wrong secret
			const request = await createWebhookRequest(payload, 'wrong-secret');

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(401);
			const body = await response.json() as { verified: boolean };
			expect(body.verified).toBe(false);
		});
	});

	describe('GitHub Actions forwarding', () => {
		it('forwards verified webhook to GitHub Actions successfully', async () => {
			const payload = createValidPayload();
			const request = await createWebhookRequest(payload, testSecret);

			// Mock successful GitHub API response
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 204,
			} as Response);
			vi.stubGlobal('fetch', mockFetch);

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as { verified: boolean; forwarded: boolean };
			expect(body.verified).toBe(true);
			expect(body.forwarded).toBe(true);

			// Verify GitHub API was called correctly
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toBe('https://api.github.com/repos/owner/repo/dispatches');
			expect(options.method).toBe('POST');
			expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-github-token');
			expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
			expect((options.headers as Record<string, string>)['Accept']).toBe('application/vnd.github.v3+json');

			const dispatchPayload = JSON.parse(options.body as string) as { event_type: string; client_payload: { body: unknown; verified: boolean } };
			expect(dispatchPayload.event_type).toBe('qlik-webhook');
			expect(dispatchPayload.client_payload.body).toEqual(payload);
			expect(dispatchPayload.client_payload.verified).toBe(true);
		});

		it('handles GitHub API failure gracefully', async () => {
			const payload = createValidPayload();
			const request = await createWebhookRequest(payload, testSecret);

			// Mock failed GitHub API response
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
				text: async () => 'GitHub API error',
			} as Response);
			vi.stubGlobal('fetch', mockFetch);

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as { verified: boolean; forwarded: boolean; error: string };
			expect(body.verified).toBe(true);
			expect(body.forwarded).toBe(false);
			expect(body.error).toBe('Failed to trigger GitHub Actions');
		});

		it('handles GitHub API network errors', async () => {
			const payload = createValidPayload();
			const request = await createWebhookRequest(payload, testSecret);

			// Mock network error
			const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
			vi.stubGlobal('fetch', mockFetch);

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as { verified: boolean; forwarded: boolean; error: string };
			expect(body.verified).toBe(true);
			expect(body.forwarded).toBe(false);
			expect(body.error).toBe('Error forwarding webhook');
		});

		it('handles invalid GITHUB_REPO format', async () => {
			const payload = createValidPayload();
			const request = await createWebhookRequest(payload, testSecret);

			const invalidEnv = {
				...testEnv,
				GITHUB_REPO: 'invalid-format',
			} as Env;

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, invalidEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as { verified: boolean; forwarded: boolean; error: string };
			expect(body.verified).toBe(true);
			expect(body.forwarded).toBe(false);
			expect(body.error).toBe('Error forwarding webhook');
		});

		it('returns success without forwarding when GitHub credentials are missing', async () => {
			const payload = createValidPayload();
			const request = await createWebhookRequest(payload, testSecret);

			const envWithoutGitHub = {
				QLIK_WEBHOOK_SECRET: testSecret,
			} as Env;

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, envWithoutGitHub, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as { verified: boolean; forwarded?: boolean };
			expect(body.verified).toBe(true);
			expect(body.forwarded).toBeUndefined();
		});
	});

	describe('Webhook payload validation', () => {
		it('returns 400 when data.id is missing', async () => {
			const payload = {
				type: 'automation.finished',
				data: {
					automation: {
						id: 'automation-12345',
					},
				},
			};
			const request = await createWebhookRequest(payload, testSecret);

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
			const body = await response.json() as { error: string };
			expect(body.error).toBe('Missing data.id in webhook payload');
		});

		it('returns 400 when data.automation.id is missing', async () => {
			const payload = {
				type: 'automation.finished',
				data: {
					id: 'automation-run-12345',
				},
			};
			const request = await createWebhookRequest(payload, testSecret);

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(400);
			const body = await response.json() as { error: string };
			expect(body.error).toBe('Missing data.automation.id in webhook payload');
		});
	});

	describe('End-to-end flow', () => {
		it('verifies signature, validates payload, and forwards to GitHub Actions', async () => {
			const payload = createValidPayload({
				timestamp: '2024-01-01T12:00:00Z',
			});
			const request = await createWebhookRequest(payload, testSecret);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 204,
			} as Response);
			vi.stubGlobal('fetch', mockFetch);

			const ctx = createExecutionContext();
			const response = await worker.fetch(request, testEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Verify complete flow
			expect(response.status).toBe(200);
			const body = await response.json() as { success: boolean; verified: boolean; forwarded: boolean; automationId: string; automationRunId: string };
			expect(body.success).toBe(true);
			expect(body.verified).toBe(true);
			expect(body.forwarded).toBe(true);

			// Verify GitHub API was called
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
			const dispatchPayload = JSON.parse(options.body as string) as { event_type: string; client_payload: { verified: boolean } };
			expect(dispatchPayload.event_type).toBe('qlik-webhook');
			expect(dispatchPayload.client_payload.verified).toBe(true);
			expect(body.automationId).toBe('automation-12345');
			expect(body.automationRunId).toBe('automation-run-12345');
		});
	});
});
