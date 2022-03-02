var colors = require('colors');

// Stylize console output
colors.setTheme({
	info: ['white'],
	instructions: ['bold','white'],
	warn: ['bold','yellow'],
	success: ['bold','green'],
	error: ['bold','red']
});

export function error(msg) {
	console.log('☠️  ' + msg.error);
}

export function info(msg) {
	console.log(msg.info);
}

export function instructions(msg) {
	console.log('ℹ️  ' + msg.instructions);
}

export function success(msg) {
	console.log('👍 ' + msg.success);
}

export function warn(msg) {
	console.log('🚨 ' + msg.warn);
}
