/**
 * Lazy-load Static Kit and keep its logger on the same colour contract as us.
 *
 * Static Kit paints with the `colors` package, which does not honour NO_COLOR
 * (it keys off TERM / FORCE_COLOR). A piped `wonderpress` run with NO_COLOR
 * would otherwise leak Static Kit's escape sequences onto stdout. Disable that
 * copy of `colors` when we ourselves are not colouring.
 **/
export async function importStaticKit() {
	const staticCli = await import('@wndrfl/static-kit-cli');
	if (process.env.NO_COLOR && process.env.FORCE_COLOR !== '1') {
		try {
			const colors = (await import('colors')).default;
			colors.disable();
		} catch {
			// colors is Static Kit's dependency; a stripped install has nothing to mute.
		}
	}
	return staticCli;
}
