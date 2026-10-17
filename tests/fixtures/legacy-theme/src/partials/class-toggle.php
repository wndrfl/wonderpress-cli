<?php
/**
 * A Toggle partial class: boolean formats, short array syntax, double quotes.
 *
 * @package Wonderpress Theme
 */

namespace Wonderpress\Partials;

use Wonderpress_Core\Partials\Abstract_Partial;

/**
 * Toggle
 * Wonderpress\Partials\Toggle
 */
class Toggle extends Abstract_Partial {

	/**
	 * A relative path to a partial template to use as the view for this partial.
	 *
	 * @var String|Boolean $_partial_template
	 */
	protected $_partial_template = './partials/toggle.php';

	/**
	 * A definition of all available properties.
	 *
	 * @var Array $_properties
	 */
	protected static $_properties = [
		// A required boolean: manifests cannot require one.
		'visible' => [
			'description' => "Whether it's shown",
			'format'      => 'boolean',
			'required'    => true,
		],
		'compact' => array(
			'description' => 'Tighter spacing',
			'format'      => 'bool',
			'required'    => false,
		),
		'label' => array(
			'description' => 'Button label',
			'format'      => 'string',
			'required'    => false,
		),
	];
}
