<?php

/**
 * A theme-text-stack partial template.
 *
 * @package Wonderpress Theme
 */

$eyebrow_headline_level = 'h2';
$headline_headline_level = ( isset( $eyebrow ) && ! empty( $eyebrow ) ) ? 'h3' : 'h2';

?>
<!-- Partial: theme-text-stack -->
<div class="theme-text-stack">
	<header class="theme-text-stack__header">
		<?php if ( isset( $eyebrow ) && ! empty( $eyebrow ) ) { ?>
			<<?php echo esc_attr( $eyebrow_headline_level ); ?> class="theme-text-stack__eyebrow">
				<?php echo esc_html( $eyebrow ); ?>
			</<?php echo esc_attr( $eyebrow_headline_level ); ?>>
		<?php } ?>
		<?php if ( isset( $headline ) && ! empty( $headline ) ) { ?>
			<<?php echo esc_attr( $headline_headline_level ); ?> class="theme-text-stack__headline">
				<?php echo esc_html( $headline ); ?>
			</<?php echo esc_attr( $headline_headline_level ); ?>>
		<?php } ?>
	</header>
	<?php if ( isset( $paragraph ) && ! empty( $paragraph ) ) { ?>
		<div class="theme-text-stack__paragraph">
			<?php echo wp_kses_post( $paragraph ); ?>
		</div>
	<?php } ?>
</div>
<!-- End: theme-text-stack -->
