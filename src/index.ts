/**
 * Qlik Cloud Webhook Receiver with HMAC Verification
 * 
 * This worker receives webhooks from Qlik Cloud, verifies them using HMAC-SHA256,
 * and forwards verified webhooks to a GitHub Actions webhook URL.
 */

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Only handle POST requests to /webhook
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/webhook') {
			return new Response('Not Found', { status: 404 });
		}

		// Get the signature header
		const signature = request.headers.get('qlik-signature');
		
		// Get the raw body for HMAC verification
		const rawBody = await request.arrayBuffer();
		
		// Validate header and payload exist
		if (!signature || !rawBody) {
			return new Response(
				JSON.stringify({ error: 'Missing signature or payload' }),
				{ 
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}

		// Verify HMAC signature
		const isValid = await verifyHMAC(
			rawBody,
			signature,
			env.QLIK_WEBHOOK_SECRET
		);

		if (!isValid) {
			console.log('✗ Webhook signature is invalid. Payload may have been tampered with.');
			return new Response(
				JSON.stringify({ error: 'Invalid signature', verified: false }),
				{ 
					status: 401,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}

		console.log('✓ Webhook signature is valid. Payload is authentic.');

		// Parse the body to get event type
		const body = JSON.parse(new TextDecoder().decode(rawBody));
		console.log(`Event type: ${body.type}`);

		// Validate that data.id exists (automation run id)
		if (!body.data || !body.data.id) {
			console.error('✗ Missing data.id in webhook payload');
			return new Response(
				JSON.stringify({ error: 'Missing data.id in webhook payload', verified: true }),
				{ 
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}

		// Validate that data.automation.id exists (automation id)
		if (!body.data.automation || !body.data.automation.id) {
			console.error('✗ Missing data.automation.id in webhook payload');
			return new Response(
				JSON.stringify({ error: 'Missing data.automation.id in webhook payload', verified: true }),
				{ 
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}

		// Log automation run id and automation id
		const automationRunId = body.data.id;
		const automationId = body.data.automation.id;
		console.log(`Automation run ID (data.id): ${automationRunId}`);
		console.log(`Automation ID (data.automation.id): ${automationId}`);

		// Forward the webhook to GitHub Actions via repository_dispatch
		if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
			try {
				const [owner, repo] = env.GITHUB_REPO.split('/');
				if (!owner || !repo) {
					throw new Error('Invalid GITHUB_REPO format. Expected: owner/repo');
				}

				const githubApiUrl = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
				
				const dispatchPayload = {
					event_type: 'qlik-webhook',
					client_payload: {
						body: body,
						verified: true,
					},
				};

				const forwardResponse = await fetch(githubApiUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
						'Accept': 'application/vnd.github.v3+json',
						'User-Agent': 'Qlik-Cloud-Webhook-Worker',
					},
					body: JSON.stringify(dispatchPayload),
				});

				if (!forwardResponse.ok) {
					const errorText = await forwardResponse.text();
					console.error(`Failed to trigger GitHub Actions: ${forwardResponse.status} ${forwardResponse.statusText}`);
					console.error(`Error details: ${errorText}`);
					return new Response(
						JSON.stringify({ 
							success: true, 
							verified: true,
							forwarded: false,
							error: 'Failed to trigger GitHub Actions',
							details: errorText
						}),
						{ 
							status: 200,
							headers: { 'Content-Type': 'application/json' }
						}
					);
				}

				console.log('✓ Webhook forwarded successfully to GitHub Actions');
				return new Response(
					JSON.stringify({ 
						success: true, 
						verified: true,
						forwarded: true
					}),
					{ 
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				);
			} catch (error) {
				console.error('Error forwarding webhook:', error);
				return new Response(
					JSON.stringify({ 
						success: true, 
						verified: true,
						forwarded: false,
						error: 'Error forwarding webhook',
						details: error instanceof Error ? error.message : String(error)
					}),
					{ 
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				);
			}
		}

		// If no forwarding URL is configured, just return success
		return new Response(
			JSON.stringify({ success: true, verified: true }),
			{ 
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	},
} satisfies ExportedHandler<Env>;

/**
 * Verify HMAC-SHA256 signature
 */
async function verifyHMAC(
	payload: ArrayBuffer,
	signature: string,
	secret: string
): Promise<boolean> {
	try {
		// Import the secret key
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);

		// Compute HMAC
		const computedSignature = await crypto.subtle.sign(
			'HMAC',
			key,
			payload
		);

		// Convert to hex string
		const computedHex = Array.from(new Uint8Array(computedSignature))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		// Compare signatures (constant-time comparison)
		return computedHex === signature;
	} catch (error) {
		console.error('Error verifying HMAC:', error);
		return false;
	}
}
