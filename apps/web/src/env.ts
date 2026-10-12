import { building } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/env';

const MiB = 1024 * 1024;

/** Required when the server starts, but not while `vite build` analyses the app. */
function required(name: string, minLength = 1) {
	return (value: string | undefined) => {
		if (building) return value ?? '';
		if (!value || value.length < minLength) {
			throw new Error(
				minLength > 1 ? `${name} must be at least ${minLength} characters` : `${name} must be set`
			);
		}
		return value;
	};
}

function megabytes(name: string, fallback: number) {
	return (value: string | undefined) => {
		if (value === undefined || value === '') return fallback * MiB;
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			throw new Error(`${name} must be a positive whole number of megabytes`);
		}
		return parsed * MiB;
	};
}

function count(name: string, fallback: number) {
	return (value: string | undefined) => {
		if (value === undefined || value === '') return fallback;
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 1) {
			throw new Error(`${name} must be a positive whole number`);
		}
		return parsed;
	};
}

export const variables = defineEnvVars({
	DATABASE_URL: {
		description: 'PostgreSQL connection string',
		schema: required('DATABASE_URL')
	},
	KERNIC_DATA_DIR: {
		description: 'Directory for project files and rendered artifacts',
		schema: (value) => value || './data'
	},
	KERNIC_WORKER_URL: {
		description: 'Base URL of the Typst compile worker',
		schema: (value) => (value || 'http://127.0.0.1:3101').replace(/\/+$/, '')
	},
	KERNIC_WORKER_TOKEN: {
		description: 'Shared secret that authenticates this app to the compile worker',
		schema: required('KERNIC_WORKER_TOKEN', 24)
	},
	KERNIC_SETUP_TOKEN: {
		description: 'Optional fixed token for first-run setup; generated and logged when unset',
		schema: (value) => value || undefined
	},
	KERNIC_PACKAGE_REGISTRY: {
		description: 'Base URL of the Typst package registry, or "off" to disable package downloads',
		schema: (value) => {
			if (!value) return 'https://packages.typst.org';
			if (value.toLowerCase() === 'off') return null;
			if (!/^https?:\/\//.test(value)) {
				throw new Error('KERNIC_PACKAGE_REGISTRY must be an http(s) URL or "off"');
			}
			return value.replace(/\/+$/, '');
		}
	},
	KERNIC_MAX_FILE_MB: {
		description: 'Largest single file a project may contain',
		schema: megabytes('KERNIC_MAX_FILE_MB', 25)
	},
	KERNIC_MAX_PROJECT_MB: {
		description: 'Largest total size of one project',
		schema: megabytes('KERNIC_MAX_PROJECT_MB', 200)
	},
	KERNIC_MAX_PROJECT_FILES: {
		description: 'Largest number of files in one project',
		schema: count('KERNIC_MAX_PROJECT_FILES', 2000)
	},
	KERNIC_MAX_WORKSPACE_MB: {
		description: 'Largest total size of the projects in one workspace',
		schema: megabytes('KERNIC_MAX_WORKSPACE_MB', 2000)
	},
	KERNIC_MAX_WORKSPACE_PROJECTS: {
		description: 'Largest number of projects in one workspace',
		schema: count('KERNIC_MAX_WORKSPACE_PROJECTS', 200)
	},
	KERNIC_GIT_HOSTS: {
		description:
			'Hosts whose Git repositories projects may be connected to, separated by commas; unset turns this off',
		schema: (value) => value || ''
	},
	KERNIC_SECRET_KEY: {
		description:
			'Key that encrypts stored access tokens, at least 32 characters; required with KERNIC_GIT_HOSTS',
		schema: (value) => value || ''
	},
	KERNIC_MAX_WAITING_COMPILES: {
		description: 'Most compiles one account may have waiting or running at the same time',
		schema: count('KERNIC_MAX_WAITING_COMPILES', 20)
	}
});
