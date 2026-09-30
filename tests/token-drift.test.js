import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	bridgeNames,
	checkThemeTokenDrift,
	checkTokenDrift,
} from '../src/token-drift.js';

const matched = {
	settings: {
		color: {
			palette: [{ slug: 'blue', color: '#7a97ab' }],
		},
		typography: {
			fontFamilies: [{ slug: 'sans-serif' }],
			fontSizes: [{ slug: 'small', size: '0.875rem' }],
		},
		custom: {
			type: { h2: { size: '1.5rem', sizeTablet: '3rem' } },
			color: { error: '#f03d3e' },
		},
	},
	sources: [
		'$color-blue: var(--color-blue, #7A97AB);\n',
		'$font-sans-serif: var(--font-sans-serif, system-ui, sans-serif);\n',
		'$type-h2-size: var(--type-h2-size, 1.5rem);\n$type-h2-size-tablet: var(--type-h2-size-tablet, 3rem);\n',
		'$color-error: var(--color-error, #F03D3E);\n',
	],
};

test('matching tokens and theme.json produce no issues', () => {
	const result = checkTokenDrift(matched);
	assert.equal(result.ok, true);
	assert.deepEqual(result.issues, []);
	assert.equal(bridgeNames(matched.settings).has('--font-size-small'), false);
});

test('a kit token with no theme.json slot is unbridged', () => {
	const result = checkTokenDrift({
		settings: matched.settings,
		sources: [
			...matched.sources,
			'$color-red: var(--color-red, #F00);\n',
		],
	});
	assert.equal(result.ok, false);
	assert.deepEqual(
		result.issues.filter((issue) => issue.code === 'unbridged').map((issue) => issue.name),
		['--color-red'],
	);
});

test('a theme.json slot nothing consumes is stale', () => {
	const result = checkTokenDrift({
		settings: {
			...matched.settings,
			color: {
				palette: [
					...matched.settings.color.palette,
					{ slug: 'purple', color: '#800080' },
				],
			},
		},
		sources: matched.sources,
	});
	assert.equal(result.ok, false);
	const stale = result.issues.filter((issue) => issue.code === 'stale');
	assert.deepEqual(stale.map((issue) => issue.name), ['--color-purple']);
	assert.match(stale[0].message, /no token file consumes it/);
});

test('core default presets are not bridged', () => {
	const names = bridgeNames({
		color: {
			palette: {
				theme: [{ slug: 'blue' }],
				default: [{ slug: 'vivid-red' }],
			},
		},
	});
	assert.equal(names.has('--color-blue'), true);
	assert.equal(names.has('--color-vivid-red'), false);
});

test('checkThemeTokenDrift skips a theme with no token directory', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-tokens-'));
	try {
		const result = checkThemeTokenDrift(root);
		assert.equal(result.ok, true);
		assert.equal(result.skipped, true);
	} finally {
		fs.removeSync(root);
	}
});
