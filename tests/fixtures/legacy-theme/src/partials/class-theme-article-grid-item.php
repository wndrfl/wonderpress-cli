<?php
/**
 * A Link partial class.
 *
 * @package Wonderpress Theme
 */

namespace Wonderpress\Partials;

use Wonderpress_Core\Partials\Abstract_Partial;

/**
 * Link
 * Wonderpress\Partials\Image
 */
class Theme_Article_Grid_Item extends Abstract_Partial {

	/**
	 * A definition of all available properties.
	 *
	 * @var Array $_properties
	 */
	protected static $_properties = array(
		'post_obj' => array(
			'description' => 'The post object to display',
			'format' => 'object',
			'required' => true,
		),
		'attributes' => array(
			'description' => 'An array of arbitrary attributes for the element',
			'format' => 'array',
			'required' => false,
		),
		'classes' => array(
			'description' => 'The classes for the element',
			'format' => 'string|array',
			'required' => false,
		),
		'type' => array(
			'description' => 'The type of grid item to display',
			'format' => 'string',
			'required' => false,
		),
	);


	/**
	 * An internal process to merge the property values and HTML bits into a
	 * usable HTML snippet.
	 *
	 * @return void
	 */
	public function render_into_template() {
		switch ( $this->type ) {
			case 'dome':
				wonder_include_template_file( 'partials/theme-article-grid-item-dome.php', $this->_attrs );
				break;
			case 'full':
				wonder_include_template_file( 'partials/theme-article-grid-item-full.php', $this->_attrs );
				break;
			case 'normal':
			default:
				wonder_include_template_file( 'partials/theme-article-grid-item-normal.php', $this->_attrs );
				break;
		}
	}
}
