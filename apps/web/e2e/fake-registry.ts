/**
 * A stand-in for the Typst package registry, so the tests neither depend on the
 * network nor on what is published upstream. Serves a few small packages,
 * including a hostile one.
 */
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { registryPort } from './environment.ts';

const manifest = (name: string, version: string) =>
	`[package]\nname = "${name}"\nversion = "${version}"\nentrypoint = "lib.typ"\n`;

async function archive(
	files: Record<string, string>,
	links: Record<string, string> = {}
): Promise<Buffer> {
	const directory = await mkdtemp(path.join(tmpdir(), 'kernic-fake-package-'));
	for (const [name, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
		await writeFile(path.join(directory, name), content);
	}
	for (const [name, target] of Object.entries(links))
		await symlink(target, path.join(directory, name));

	const chunks: Buffer[] = [];
	const names = [...Object.keys(files), ...Object.keys(links)];
	for await (const chunk of tar.c({ gzip: true, cwd: directory }, names))
		chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

const packages: Record<string, Buffer> = {
	'greeting-0.1.0': await archive({
		'typst.toml': manifest('greeting', '0.1.0'),
		'lib.typ':
			'#import "@preview/punctuation:1.2.0": mark\n#let greet(name) = [Greetings, #name#mark]\n'
	}),
	'punctuation-1.2.0': await archive({
		'typst.toml': manifest('punctuation', '1.2.0'),
		'lib.typ': '#let mark = "!"\n'
	}),
	// Tries to smuggle a link to a file of the server into the package directory.
	'hostile-1.0.0': await archive(
		{ 'typst.toml': manifest('hostile', '1.0.0'), 'lib.typ': '#let secret = read("stolen.txt")\n' },
		{ 'stolen.txt': '/etc/hostname' }
	)
};

createServer((request, response) => {
	const match = /^\/preview\/([a-z0-9.-]+)\.tar\.gz$/.exec(request.url ?? '');
	const body = match && packages[match[1]!];
	if (request.url === '/healthz') {
		response.writeHead(200).end('ok');
	} else if (body) {
		response.writeHead(200, { 'content-type': 'application/gzip' }).end(body);
	} else {
		response.writeHead(404).end('not found');
	}
}).listen(registryPort, '127.0.0.1');
