<?php

/**
 * A theme-project-grid-item partial template.
 *
 * @package Wonderpress Theme
 */

$project_roles = wonder_get_project_roles( $project_obj );
$project_roles_str = implode( ', ', wp_list_pluck( $project_roles, 'name' ) );

$project_tagline = get_field( 'global_tagline', $project_obj );

$subheadline = $project_tagline ? $project_tagline : $project_roles_str;

?>
<!-- Partial: theme-project-grid-item -->
<div class="theme-project-grid-item">
	<a href="<?php echo esc_url( get_the_permalink( $project_obj ) ); ?>" aria-label="Read about our project with <?php echo esc_attr( get_the_title( $project_obj ) ); ?>" class="theme-project-grid-item">
		<div class="theme-project-grid-item__image">
			<?php
			try {
				wonder_image(
					array(
						'src' => get_the_post_thumbnail_url( $project_obj, $image_size ),
						'classes' => 'theme-project-grid-item__img',
					)
				);
			} catch ( Exception $e ) {
				// Handle the exception
				unset( $e );
			}
			?>
		</div>
		<div class="theme-project-grid-item__content">
			<h2 class="theme-project-grid-item__headline">
				<?php echo esc_html( get_the_title( $project_obj ) ); ?>
			</h2>
			<div class="theme-project-grid-item__subheadline">
				<?php echo esc_html( $subheadline ); ?>
			</div>
		</div>
		<div class="theme-project-grid-item__quip">
			<svg xmlns="http://www.w3.org/2000/svg" width="41" height="40" viewBox="0 0 41 40" fill="none">
				<path d="M13.0078 14.1663L20.5078 6.66634M20.5078 6.66634L28.0078 14.1663M20.5078 6.66634V33.333" stroke="#D2F84F" stroke-width="2" stroke-linecap="square" />
			</svg>
			<span>
				<?php echo esc_html( get_field( 'short_quip', $project_obj ) ); ?>
			</span>
		</div>
	</a>
</div>
<!-- End: theme-project-grid-item -->
