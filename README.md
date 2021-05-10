# ✨Wonderpress CLI
A commandline interface for bootstrapping and working with the Wonderpress WordPress environment. 

## Installation

Using npm:

```
$ npm install -g @wndrfl/wonderpress-cli
```

## Quick Start
The most basic invocation of the Wonderpress CLI operates as a wizard-style program. Simply running `$ wonderpress` in the command-line will present you with a table of contents of the various available features:

```
$ wonderpress
? What would you like to do? (Use arrow keys)
❯ Setup the Wonderpress Development Environment
  Start a development server
  Install the Wonderpress Theme
  Lint the active theme
  Create a README
```

## Commands
The Wonderpress provides different commands for many common tasks.

- `wonderpress install_wonderpress_theme` - Installs the [Wonderpress Theme](https://github.com/wndrfl/wonderpress-theme).

- `wonderpress lint [-f --fix]` - Lints the current active WordPress theme against the [Wonderpress Coding Standards](https://github.com/wndrfl/wonderpress-development-environment/blob/master/phpcs.xml) (which is a slightly modified flavor of the [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/)). Optionally, Wonderpress can attempt to automatically "fix" lightweight issues if the `fix` or `-f` arguments are passed.

- `wonderpress readme` - Starts a wizard to aid in the creation of a new README file.

- `wonderpress setup [-c --clean-slate]` - Sets up a "Wonderpress" flavored WordPress Development Environment from scratch, configures and installs WordPress, installs various developer tools, and optionally installs a blank theme. Optionally, Wonderpress can completely wipe the current install and setup from scratch (this is super duper dangerous and should only be run if you really don't care about your previous work with the directory).

- `wonderpress server` - Starts web server to run WordPress locally. (uses [WP CLI](https://developer.wordpress.org/cli/commands/server/))


## License
MIT

## Collaborators
- Johnnie Munger johnnie@wonderful.io