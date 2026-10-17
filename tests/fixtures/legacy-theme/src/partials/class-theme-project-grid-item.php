<?php

/**
 * An Theme_Project_Grid_Item partial class.
 *
 * @package Wonderpress Theme
 */

namespace Wonderpress\Partials;

use Wonderpress_Core\Partials\Abstract_Partial;

/**
 * Theme_Project_Grid_Item
 * Wonderpress\Partials\Theme_Project_Grid_Item
 */
class Theme_Project_Grid_Item extends Abstract_Partial {


	/**
	 * A relative path to a partial template to use as the view for this partial.
	 *
	 * @var String|Boolean $_partial_template
	 */
	protected $_partial_template = './partials/theme-project-grid-item.php';

	/**
	 * A definition of all available properties.
	 *
	 * @var Array $_properties
	 */
	protected static $_properties = array(
		'project_obj' => array(
			'description' => 'The project object to display',
			'format' => 'object',
			'required' => true,
		),
		'image_size' => array(
			'description' => 'The image size to display',
			'format' => 'string',
			'required' => true,
			'default' => 'large',
		),
	);
}
