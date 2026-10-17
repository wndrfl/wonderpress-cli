<?php
/**
 * An Theme_Text_Stack partial class.
 *
 * @package Wonderpress Theme
 */

namespace Wonderpress\Partials;

use Wonderpress_Core\Partials\Abstract_Partial;

/**
 * Theme_Text_Stack
 * Wonderpress\Partials\Theme_Text_Stack
 */
class Theme_Text_Stack extends Abstract_Partial {

	/**
	 * Whether this partial accepts an ACF parameter for easy hydration.
	 *
	 * @var Boolean $_acf_compatible
	 */
	protected $_acf_compatible = true;

	/**
	 * A relative path to a partial template to use as the view for this partial.
	 *
	 * @var String|Boolean $_partial_template
	 */
	protected $_partial_template = './partials/theme-text-stack.php';

	/**
	 * A definition of all available properties.
	 *
	 * @var Array $_properties
	 */
	protected static $_properties = array(
		'eyebrow' => array(
			'description' => 'The text for the eyebrow',
			'format' => 'string',
			'required' => false,
		),
		'headline' => array(
			'description' => 'The text for the headline',
			'format' => 'string',
			'required' => false,
		),
		'paragraph' => array(
			'description' => 'The text for the paragraph',
			'format' => 'string',
			'required' => false,
		),
	);
}
