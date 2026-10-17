<?php

/**
 * A template for a Block Quote.
 *
 * @package Wonderpress Theme
 */

?>
<div class="block-quote" data-block-quote>
	<div class="block-quote__grid">
		<div class="block-quote__content">
			<?php if ( get_field( 'eyebrow' ) ) { ?>
				<h2 class="block-quote__eyebrow">
					<?php the_field( 'eyebrow' ); ?>
				</h2>
			<?php } ?>

			<?php if ( get_field( 'quote' ) ) { ?>
				<div class="block-quote__quote">
					<?php the_field( 'quote' ); ?>
				</div>
			<?php } ?>

			<?php
			if ( get_field( 'logo' ) ) {
				try {
					?>
					<div class="block-quote__source">
						<?php
						wonder_image( array( 'acf' => get_field( 'logo' ) ) );
						?>
					</div>
					<?php
				} catch ( \Exception $e ) {
					unset( $e );
				}
			}
			?>
		</div>
	</div>
</div>
