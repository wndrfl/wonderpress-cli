# ✨Wonderpress CLI
A commandline interface for bootstrapping and working with the Wonderpress-flavored WordPress development environment.

## Installation

Using npm:

```
$ npm install -g @wndrfl/wonderpress-cli
```

## Commands
The Wonderpress provides different commands for many common tasks.

- `wonderpress lint [-f --fix]` - Lints the current active WordPress theme against the [Wonderpress Coding Standards](https://github.com/wndrfl/wonderpress-development-environment/blob/master/phpcs.xml) (which is a slightly modified flavor of the [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/)). Optionally, Wonderpress can attempt to automatically "fix" lightweight issues if the `fix` or `-f` arguments are passed.

- `wonderpress readme create` - Starts a wizard to aid in the creation of a new README file.

- `wonderpress init` - Sets up (or initializes) a "Wonderpress" flavored WordPress Development Environment, configures and installs WordPress, installs various developer tools, and optionally installs a blank Wonderpress boilerplate theme.

- `wonderpress partial create` - Create a Wonderpress "partial" (both a PHP class and an accompanying view template) within the active Wonderpress-friendly theme.

- `wonderpress server` - Starts web server to run WordPress locally. (uses [WP CLI](https://developer.wordpress.org/cli/commands/server/))


## License
MIT

## Collaborators
- Johnnie Munger johnnie@wonderful.io
