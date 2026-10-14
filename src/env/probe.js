import fs from 'fs-extra';
import net from 'net';
import path from 'path';

/**
 * Network and config probes shared by the backends, `server status` and
 * `doctor`.
 *
 * Kept apart from the backends so doctor can use them without importing a
 * backend (the backends import doctor for their preflight, and the other
 * direction would close a cycle).
 *
 * Everything here is answered from Node, never by shelling out to `lsof` or
 * `netstat`: neither exists on Windows, and the app runs this CLI there.
 **/

export const DEFAULT_WP_ENV_PORT = 8888;

/**
 * Is a TCP port free to bind? Bound on 0.0.0.0 because Docker publishes on
 * every interface — checking only loopback would miss a conflict.
 **/
export function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => server.close(() => resolve(true)));
		server.listen(port, '0.0.0.0');
	});
}

/**
 * Is something accepting connections on host:port?
 *
 * The other half of isPortFree(), and not its negation: a port can be
 * unbindable (another process holds it on one interface) and still refuse a
 * loopback connection. "Is the site up" is a question about connecting, so
 * that is what this asks. The short timeout keeps `server status` snappy when
 * a firewall drops packets rather than refusing them.
 **/
export function isPortListening(port, host = '127.0.0.1', timeoutMs = 750) {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host });
		const done = (answer) => {
			socket.removeAllListeners();
			socket.on('error', () => {});
			socket.destroy();
			resolve(answer);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
	});
}

/**
 * The port in a project's .wp-env.json, or wp-env's default.
 **/
export function readWpEnvPort(root) {
	try {
		const port = JSON.parse(fs.readFileSync(path.join(root || process.cwd(), '.wp-env.json'), 'utf8')).port;
		return Number(port) || DEFAULT_WP_ENV_PORT;
	} catch (e) {
		return DEFAULT_WP_ENV_PORT;
	}
}

/**
 * Split a site URL into what a probe needs.
 *
 * `localhost` is probed as 127.0.0.1: where localhost resolves to ::1 first, a
 * connect by name can miss a server bound on IPv4 only, which is what both
 * `wp server` and Docker do by default.
 **/
export function urlTarget(url) {
	if (!url) {
		return null;
	}
	try {
		const u = new URL(/^https?:\/\//.test(url) ? url : `http://${url}`);
		const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
		const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, '');
		return { host, port };
	} catch (e) {
		return null;
	}
}
