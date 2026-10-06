import { defineConfig } from '@playwright/test';
import {
	adminStorageState,
	appPort,
	baseURL,
	dataDir,
	databaseUrl,
	setupToken,
	workerDir,
	workerPort,
	workerToken
} from './e2e/environment.ts';

/**
 * End-to-end tests run against the production build (`pnpm build`) and a real
 * compile worker, with their own database and data directory.
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
		extraHTTPHeaders: { 'x-forwarded-proto': 'http' }
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
	webServer: [
		{
			command: 'node ../worker/src/main.ts',
			url: `http://127.0.0.1:${workerPort}/healthz`,
			reuseExistingServer: false,
			env: {
				KERNIC_WORKER_PORT: String(workerPort),
				KERNIC_WORKER_TOKEN: workerToken,
				KERNIC_WORKER_DIR: workerDir
			}
		},
		{
			command: 'node e2e/reset.ts && node build',
			url: `${baseURL}/healthz`,
			reuseExistingServer: false,
			env: {
				PORT: String(appPort),
				HOST: '127.0.0.1',
				PROTOCOL_HEADER: 'x-forwarded-proto',
				BODY_SIZE_LIMIT: '64M',
				DATABASE_URL: databaseUrl,
				KERNIC_DATA_DIR: dataDir,
				KERNIC_SETUP_TOKEN: setupToken,
				KERNIC_WORKER_URL: `http://127.0.0.1:${workerPort}`,
				KERNIC_WORKER_TOKEN: workerToken
			}
		}
	]
});
