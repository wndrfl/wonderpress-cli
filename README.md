# ✨Wonderpress CLI
A commandline interface for bootstrapping and working with the Wonderpress-flavored WordPress development environment.

## Table of Contents

1.  [Documentation](#documentation)
    1.  [Installation](#installation)
    2.  [Commands](#commands)
2.  [Support](#support)
3.  [Known issues](#issues)
4.  [License](#license)

## [Documentation](#documentation)

### [Installation](#installation)

Using npm:

```shell
$ npm install -g @wndrfl/wonderpress-cli
```

### [Commands](#commands)

The Wonderpress CLI provides different commands for many common tasks.

#### `wonderpress init`

Sets up (or initializes) a "Wonderpress" flavored WordPress Development Environment, configures and installs WordPress, installs various developer tools, and optionally installs a blank Wonderpress boilerplate theme.

#### `wonderpress lint [-f --fix]`

Lints the current active WordPress theme against the [Wonderpress Coding Standards](https://github.com/wndrfl/wonderpress-development-environment/blob/master/phpcs.xml) (which is a slightly modified flavor of the [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/)). Optionally, Wonderpress can attempt to automatically "fix" lightweight issues if the `fix` or `-f` arguments are passed.

#### `wonderpress readme create`

Starts a wizard to aid in the creation of a new README file.

#### `wonderpress partial create`

Create a Wonderpress "partial" (both a PHP class and an accompanying view template) within the active Wonderpress-friendly theme.

#### `wonderpress server`

Starts a web server to run WordPress locally. (uses [WP CLI](https://developer.wordpress.org/cli/commands/server/))

### [Support](#support)

The CLI has been tested on the following tools. Please let us know if how it works in your environment!

- **Mac OS**:
  - Terminal.app
  - iTerm
- **Windows**:
  - (needs testing, please let us know how it works!)
- **Linux**:
  - (needs testing, please let us know how it works!)

### [Known Issues](#issues)

Currently there are no known issues. However, if you experience something, we certainly want to know! Please submit a Github issue.

### [License](#license)

Copyright (c) 2021 Wonderful
Licensed under the MIT license.

## Collaborators
- Johnnie Munger johnnie@wonderful.io
