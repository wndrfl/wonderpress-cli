import * as log from './log.js';

/**
 * Help text for the CLI.
 *
 * Kept as data rather than scattered through the command modules so that every
 * topic reads in one voice, and so `help` can list what exists without each
 * module having to announce itself.
 *
 * The partial/block topics lead with the relationship between the two rather
 * than a flag table: "how do I make a block" is a question about the model, and
 * answering it with an option list is what sends people back here twice.
 **/

const TOPICS = {

	main: `wonderpress — build WordPress themes the Wonderpress way

USAGE
  wonderpress <command> [subcommand] [options]

ENVIRONMENT
  init          Build a new environment: WordPress, the theme, and Static Kit
  server        Start a local development server
  lint          Run phpcs over the theme
  version       Print the installed version

AUTHORING
  partial       Reusable render primitives — the unit of markup in a theme
  block         Editor wrappers that expose a partial in Gutenberg
  template      Create a page template
  readme        Generate a project README

Run \`wonderpress <command> help\` for detail on any of these — start with
\`wonderpress partial help\` if you are new; almost everything begins there.`,

	partial: `wonderpress partial — reusable render primitives

A partial is a PHP class plus a view template: the unit of markup in a
Wonderpress theme. Once created it can be rendered two ways, from one source:

  from PHP        echo new \\Wonderpress\\Partials\\Testimonial([ ... ]);
  in the editor   by also giving it a block — see \`wonderpress block help\`

COMMANDS
  partial create           Create one (class, view, style, optionally JS + block)
  partial list             List every partial, and whether a block wraps it
  partial remove <Name>    Delete a partial and everything it owns

CREATE OPTIONS
  --name <Class_Name>      WordPress snake-case, e.g. Testimonial_Card
  --prop <name:type[:required]>
                           A property, repeatable. Types: string, int, bool,
                           array, object
  --block                  Also expose it in the editor (off by default —
                           most partials are compositional, not blocks)
  --js                     Also scaffold a JS behavior class (off by default)
  --acf                    Mark the partial ACF compatible
  --template-name <file>   Name the view template, e.g. my-view.php
  --no-template            Class only, no view template
  --no-style               Skip the SCSS stub
  --no-manifest            Skip the manifest (cannot be combined with --block)
  --json <spec|@file>      Create from a JSON spec instead of flags
  --theme <name>           Target a theme by name, skipping the active lookup

REMOVE OPTIONS
  --with-block             Also remove the block wrapping this partial.
                           Without it, remove refuses when a block exists.

EXAMPLES
  wonderpress partial create --name Testimonial --prop quote:string:required
  wonderpress partial create --name Hero --block --js
  wonderpress partial create
      No flags runs the interactive wizard, which asks the same questions.`,

	block: `wonderpress block — expose a partial in the WordPress editor

A block is a thin Gutenberg wrapper around a partial. Its render.php delegates
straight back to the partial, so there is only ever one source of markup.

  A partial is fine on its own.
  A block cannot exist without its partial.

So there is no "create a block from scratch" — you either create the partial
and its block together, or add a block to a partial you already have:

  both at once        wonderpress partial create --name Testimonial --block
  add to an existing  wonderpress block create Testimonial

Both produce identical output; use whichever matches what already exists.

COMMANDS
  block create <Name>      Add a block wrapper to an existing partial
  block list               List the partials currently exposed as blocks
  block remove <Name>      Remove the wrapper. The partial survives — this is
                           the safe way to take something out of the editor.

OPTIONS
  --theme <name>           Target a theme by name, skipping the active lookup

EXAMPLES
  wonderpress block create Testimonial
  wonderpress block list
  wonderpress block remove Testimonial

Blocks appear in the editor under the "Wonderpress" category, registered by
wonderpress-core. If a new block is missing there, check that the mu-plugin is
installed in the environment.`,

	init: `wonderpress init — build a new environment

Clones the Wonderpress development environment, downloads WordPress, creates
the database, installs wonderpress-core and Static Kit, and activates the theme.

OPTIONS
  --dir <path>             Where to build it (default: current directory)
  --yes, -y                Headless: take defaults and never prompt
  --db-host / --db-user / --db-name / --db-password
                           Database connection. Password may also come from the
                           WP_DB_PASSWORD environment variable.
  --wp-url <url>           Site URL, e.g. localhost:8080
  --wp-title <title>       Site title
  --admin-user / --admin-email / --admin-password
                           The first admin account. Password may also come from
                           WP_ADMIN_PASSWORD.
  --theme <name>           Theme to activate (default: wonderpress)
  --skip-readme            Do not generate a README

EXAMPLE
  wonderpress init --yes --db-user root --db-name my_site \\
    --wp-url localhost:8080 --wp-title "My Site" \\
    --admin-user admin --admin-email me@example.com`,
};

/**
 * Print a help topic. Unknown topics fall back to the main screen rather than
 * erroring — someone typing `help whatever` wants orientation, not a scolding.
 **/
export function show(topic) {
	log.raw(TOPICS[topic] || TOPICS.main);
	return true;
}

/**
 * Whether a topic has its own screen.
 **/
export function has(topic) {
	return Object.prototype.hasOwnProperty.call(TOPICS, topic);
}

/**
 * True when the args ask for help — `help` as a command or subcommand, or the
 * --help/-h flag anywhere.
 **/
export function requested(args) {
	return !!args['--help'] || args._.includes('help');
}
