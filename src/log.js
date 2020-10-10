var colors = require('colors');

// Stylize console output
colors.setTheme({
	info: ['bold','white'],
	warn: 'yellow',
	success: ['bold','green'],
	error: ['bold','red']
});

export function error(msg) {
	console.log('☠️ ' + msg.error);
}

export function info(msg) {
	console.log(msg.info);
}

export function success(msg) {
	console.log('👍 ' + msg.success);
}

export function warn(msg) {
	console.log('🚨 ' + msg.warn);
}