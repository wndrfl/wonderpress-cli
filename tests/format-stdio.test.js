import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as format from '../src/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

test('isProtocolChunk accepts JSON-RPC and JSON envelopes, not ANSI CSI', () => {
	assert.equal(format.isProtocolChunk('{"jsonrpc":"2.0","id":1}\n'), true);
	assert.equal(format.isProtocolChunk('  [{"jsonrpc":"2.0"}]\n'), true);
	assert.equal(format.isProtocolChunk('{"ok":true,"data":null,"error":null}\n'), true);
	assert.equal(format.isProtocolChunk('Content-Length: 12\r\n\r\n{"a":1}'), true);
	assert.equal(format.isProtocolChunk('\u001B[2m  · leaked\u001B[0m\n'), false);
	assert.equal(format.isProtocolChunk('  ✓ Partial class created at: ./hero.php\n'), false);
});

test('MCP mode keeps ANSI and log chrome off stdout', () => {
	const script = `
		import * as format from ${JSON.stringify(path.join(SRC, 'format.js'))};
		format.setMcp();
		process.stdout.write('\\u001B[2m  · Grabbing the currently active theme...\\u001B[0m\\n');
		process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\\n');
	`;
	const result = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /Grabbing/);
	assert.match(result.stdout, /"jsonrpc":"2.0"/);
	assert.match(result.stderr, /Grabbing/);
});
