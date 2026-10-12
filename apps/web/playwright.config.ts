import { defineConfig } from '@playwright/test';
import {
	adminStorageState,
	appPort,
	baseURL,
	dataDir,
	databaseUrl,
	externalBaseURL,
	forgeOrigin,
	forgePort,
	registryPort,
	setupToken,
	workerDir,
	workerPort,
	workerSandbox,
	workerToken
} from './e2e/environment.ts';

/**
 * End-to-end tests run against the production build (`pnpm build`) and a real
 * compile worker, with their own database and data directory. What the servers
 * print is kept in `e2e/.logs/`, so a crash during a run can be read afterwards.
 */
export default defineConfig({
	testDir: 'e2e',
	outputDir: 'e2e/.results',
	// The tests share one server and one account, and several of them wait on compiles.
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	reporter: 'list',
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: {
		baseURL,
		trace: 'retain-on-failure',
		// The built server assumes HTTPS unless a proxy says otherwise; in production
		// the reverse proxy sets this header.
		extraHTTPHeaders: externalBaseURL ? undefined : { 'x-forwarded-proto': 'http' },
		ignoreHTTPSErrors: !!externalBaseURL
	},
	projects: [
		{ name: 'first-run', testMatch: 'first-run.spec.ts' },
		{
			name: 'app',
			testIgnore: 'first-run.spec.ts',
			dependencies: ['first-run'],
			use: { storageState: adminStorageState }
		}
	],
	webServer: externalBaseURL
		? undefined
		: [
				{
					command: 'mkdir -p e2e/.logs && node ../worker/src/main.ts > e2e/.logs/worker.log 2>&1',
					url: `http://127.0.0.1:${workerPort}/healthz`,
					reuseExistingServer: false,
					env: {
						KERNIC_WORKER_PORT: String(workerPort),
						KERNIC_WORKER_TOKEN: workerToken,
						KERNIC_WORKER_DIR: workerDir,
						KERNIC_WORKER_SANDBOX: workerSandbox
					}
				},
				{
					command: 'node e2e/fake-registry.ts',
					url: `http://127.0.0.1:${registryPort}/healthz`,
					reuseExistingServer: false
				},
				{
					command: 'node e2e/fake-forge.ts',
					url: `http://127.0.0.1:${forgePort}/healthz`,
					reuseExistingServer: false
				},
				{
					command: 'mkdir -p e2e/.logs && node e2e/reset.ts && node build > e2e/.logs/app.log 2>&1',
					url: `${baseURL}/healthz`,
					reuseExistingServer: false,
					env: {
						PORT: String(appPort),
						HOST: '127.0.0.1',
						PROTOCOL_HEADER: 'x-forwarded-proto',
						BODY_SIZE_LIMIT: '64M',
						// As in the Docker image: idle connections outlive the client's own
						// reuse window, so a request never lands on a connection being closed.
						KEEP_ALIVE_TIMEOUT: '130',
						HEADERS_TIMEOUT: '135',
						DATABASE_URL: databaseUrl,
						KERNIC_DATA_DIR: dataDir,
						KERNIC_SETUP_TOKEN: setupToken,
						KERNIC_PACKAGE_REGISTRY: `http://127.0.0.1:${registryPort}`,
						// Small enough for a test to fill, far more than the other tests use.
						KERNIC_MAX_WORKSPACE_MB: '64',
						// The stand-in forge is the one host projects may be connected to.
						KERNIC_GIT_HOSTS: forgeOrigin,
						KERNIC_SECRET_KEY: 'e2e-secret-key-of-thirty-two-characters',
						KERNIC_WORKER_URL: `http://127.0.0.1:${workerPort}`,
						KERNIC_WORKER_TOKEN: workerToken
					}
				}
			]
});
