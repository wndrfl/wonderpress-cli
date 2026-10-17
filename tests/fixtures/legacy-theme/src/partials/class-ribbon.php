<?php
/**
 * A Ribbon partial class. The test writes a manifest for it, so it is the
 * "already migrated" case in the inventory.
 *
 * @package Wonderpress Theme
 */

namespace Wonderpress\Partials;

use Wonderpress_Core\Partials\Abstract_Partial;

class Ribbon extends Abstract_Partial {

	protected $_partial_template = './partials/ribbon.php';

	protected static $_properties = array(
		'text' => array(
			'description' => 'Ribbon text',
			'format' => 'string',
			'required' => true,
		),
	);
}
