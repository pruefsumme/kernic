import { loadConfig } from './config.ts';
import { createWorker } from './server.ts';

const config = loadConfig();
const { server, toolchain, close } = await createWorker(config);

server.listen(config.port, config.host, () => {
	console.log(
		`kernic worker listening on http://${config.host}:${config.port} ` +
			`(typst ${toolchain.typstVersion}, sandbox: ${config.sandbox})`
	);
	if (config.sandbox === 'landlock') {
		console.log('Each compile is confined with Landlock to its own files (verified at startup).');
	}
	if (config.warm.maxSessions > 0) {
		console.log(
			`Up to ${config.warm.maxSessions} projects keep a compiler running between preview compiles.`
		);
	}
	if (config.sandbox === 'none') {
		console.warn(
			'Sandbox is "none": only prlimit bounds the compiler. Run this worker in a container ' +
				'without network access, secrets or host mounts.'
		);
	}
});

function shutdown(): void {
	void close();
	server.close(() => process.exit(0));
	// Do not let a stuck connection keep the container from stopping.
	setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
