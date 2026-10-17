<?php

/**
 * A theme-blog-category-nav partial template.
 *
 * @package Wonderpress Theme
 */

global $wp;

$current_url = home_url( add_query_arg( array(), $wp->request ) );

?>
<!-- Partial: theme-blog-category-nav -->
<div class="theme-blog-category-nav">
	<nav class="theme-blog-category-nav__nav">
		<ul class="theme-blog-category-nav__list">
			<?php foreach ( wonder_get_menu_array( 'blog-category-menu' ) as $link_arr ) { ?>
				<li class="theme-blog-category-nav__list-item">
					<?php
					$is_current_page = rtrim( $link_arr['url'], '/' ) == $current_url;
					$classes = array( 'theme-button', 'theme-button--small' );
					if ( ! $is_current_page ) {
						$classes[] = 'theme-button--hollow';
					}
					wonder_link(
						array(
							'url' => $link_arr['url'],
							'content' => $link_arr['title'],
							'classes' => implode( ' ', $classes ),
						)
					);
					?>
				</li>
			<?php } ?>
		</ul>

		<div class="theme-blog-category-nav__dropdown">
			<button class="theme-blog-category-nav__dropdown-button">
				<span>Filter</span>
			</button>
			<ul class="theme-blog-category-nav__dropdown-content">
				<?php foreach ( wonder_get_menu_array( 'blog-category-menu' ) as $link_arr ) { ?>
					<?php
					$is_current_page = rtrim( $link_arr['url'], '/' ) == $current_url;
					?>
					<li>
						<?php
						wonder_link(
							array(
								'url' => $link_arr['url'],
								'content' => $link_arr['title'],
							)
						);
						?>
					</li>
				<?php } ?>
			</ul>
		</div>
	</nav>
</div>
<!-- End: theme-blog-category-nav -->
