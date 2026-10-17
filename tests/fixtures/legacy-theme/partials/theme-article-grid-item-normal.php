<?php

/**
 * A template for a Theme Article Grid Item - Normal.
 *
 * @package Wonderpress Theme
 */

// Get the primary category for the post
$primary_category_arr = wonder_get_post_primary_category( $post_obj );
$primary_category = ( isset( $primary_category_arr['primary_category'] ) ) ? $primary_category_arr['primary_category'] : null;

?>
<div class="theme-article-grid-item theme-article-grid-item--normal">
	<div class="theme-article-grid-item__image-container">
		<div class="theme-article-grid-item__image">
			<?php
			$src = get_the_post_thumbnail_url( $post_obj, 'medium' );
			if ( $src ) {

				$srcset = array(
					'1024' => get_the_post_thumbnail_url( $post_obj, 'medium' ),
					'768' => get_the_post_thumbnail_url( $post_obj, 'medium' ),
					'120' => get_the_post_thumbnail_url( $post_obj, 'medium' ),
					'0' => get_the_post_thumbnail_url( $post_obj, 'small' ),
				);

				$img = wonder_image(
					array(
						'src' => $src,
						'srcset' => $srcset,
						'width' => '413',
						'height' => '232',
						'lazy' => true,
					),
					false
				);
			}
			wonder_link(
				array(
					'content' => isset( $img ) ? $img : ' ',
					'title' => 'Read more about this article',
					'url' => get_the_permalink( $post_obj ),
				),
				true
			);
			?>
		</div>
	</div>

	<div class="theme-article-grid-item__content">
		<?php if ( $primary_category ) { ?>
			<div class="theme-article-grid-item__category">
				<?php
				echo esc_html( $primary_category->name );
				?>
			</div>
		<?php } ?>
		<h2 class="theme-article-grid-item__headline">
			<?php
			wonder_link(
				array(
					'content' => get_the_title( $post_obj ),
					'title' => 'Read more about this article',
					'url' => get_the_permalink( $post_obj ),
				),
				true
			);
			?>
		</h2>

		<p class="theme-article-grid-item__excerpt">
			<?php echo esc_html( get_the_excerpt( $post_obj ) ); ?>
		</p>
	</div>
</div>
