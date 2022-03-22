const colors = require('colors');

// Stylize console output
colors.setTheme({
	info: ['white'],
  instructions: ['bold','white'],
  meta: ['magenta'],
	warn: ['bold','yellow'],
	success: ['bold','green'],
	error: ['bold','red']
});

export function error(msg) {
	console.log(`Wonderpress ${'ERROR'.meta}: ${msg.error}`);
}

export function info(msg) {
	console.log(`Wonderpress ${'INFO'.meta}: ${msg.info}`);
}

export function instructions(msg) {
	console.log(`Wonderpress ${'INSTRUCTIONS'.instructions}:  ${msg.instructions}`);
}

export function raw(msg) {
  console.log(`${msg.info}`);
}

export function success(msg) {
  console.log(`Wonderpress ${'SUCCESS'.meta}: ${msg.success}`);
}

export function warn(msg) {
	console.log(`Wonderpress ${'WARNING'.warn}: ${msg.warn}`);
}
