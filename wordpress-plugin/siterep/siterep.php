<?php
/**
 * Plugin Name:       Site Rep — Source-Backed Website Chat
 * Plugin URI:        https://siterep.net/
 * Description:       Adds your Site Rep widget to your site. Site Rep answers visitors from your approved pages, cites the source, refuses when proof is missing, and captures leads. Paste your Workspace ID and widget key — no code.
 * Version:           1.0.0
 * Requires at least: 5.5
 * Requires PHP:      7.2
 * Author:            Site Rep
 * Author URI:        https://siterep.net/
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       siterep
 *
 * The widget key is domain-locked on the server and is safe to expose in page
 * markup — it is not a secret. This plugin stores no passwords or tokens.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // No direct access.
}

define( 'SITEREP_WIDGET_SRC', 'https://siterep.net/widget.js' );
define( 'SITEREP_API_BASE', 'https://siterep.net' );
define( 'SITEREP_OPTION', 'siterep_settings' );

/**
 * Sanitize the saved settings. Bot IDs and widget keys are conservative
 * identifier strings; the theme is a 6-digit hex colour.
 */
function siterep_sanitize_settings( $input ) {
	$out = array();
	$out['bot_id']     = isset( $input['bot_id'] ) ? preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $input['bot_id'] ) : '';
	$out['public_key'] = isset( $input['public_key'] ) ? preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) $input['public_key'] ) : '';
	$theme             = isset( $input['theme'] ) ? trim( (string) $input['theme'] ) : '';
	$out['theme']      = preg_match( '/^#[0-9a-fA-F]{6}$/', $theme ) ? $theme : '';
	return $out;
}

function siterep_register_settings() {
	register_setting(
		'siterep',
		SITEREP_OPTION,
		array(
			'type'              => 'array',
			'sanitize_callback' => 'siterep_sanitize_settings',
			'default'           => array(
				'bot_id'     => '',
				'public_key' => '',
				'theme'      => '',
			),
		)
	);
}
add_action( 'admin_init', 'siterep_register_settings' );

function siterep_add_settings_page() {
	add_options_page(
		__( 'Site Rep', 'siterep' ),
		__( 'Site Rep', 'siterep' ),
		'manage_options',
		'siterep',
		'siterep_render_settings_page'
	);
}
add_action( 'admin_menu', 'siterep_add_settings_page' );

function siterep_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$settings   = get_option( SITEREP_OPTION, array() );
	$bot_id     = isset( $settings['bot_id'] ) ? $settings['bot_id'] : '';
	$public_key = isset( $settings['public_key'] ) ? $settings['public_key'] : '';
	$theme      = isset( $settings['theme'] ) ? $settings['theme'] : '';
	$live       = ( '' !== $bot_id && '' !== $public_key );
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Site Rep', 'siterep' ); ?></h1>
		<p>
			<?php esc_html_e( 'Paste the Workspace ID and widget key from your Site Rep dashboard. The widget appears on every page of your site.', 'siterep' ); ?>
			<a href="https://siterep.net/" target="_blank" rel="noopener noreferrer"><?php esc_html_e( 'Open Site Rep', 'siterep' ); ?></a>
		</p>
		<p>
			<strong><?php esc_html_e( 'Status:', 'siterep' ); ?></strong>
			<?php echo $live ? esc_html__( 'Widget is active on your site.', 'siterep' ) : esc_html__( 'Not active yet — enter your Workspace ID and widget key below.', 'siterep' ); ?>
		</p>
		<form method="post" action="options.php">
			<?php settings_fields( 'siterep' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="siterep_bot_id"><?php esc_html_e( 'Workspace ID', 'siterep' ); ?></label></th>
					<td><input name="<?php echo esc_attr( SITEREP_OPTION ); ?>[bot_id]" id="siterep_bot_id" type="text" class="regular-text" value="<?php echo esc_attr( $bot_id ); ?>" autocomplete="off" /></td>
				</tr>
				<tr>
					<th scope="row"><label for="siterep_public_key"><?php esc_html_e( 'Widget key', 'siterep' ); ?></label></th>
					<td>
						<input name="<?php echo esc_attr( SITEREP_OPTION ); ?>[public_key]" id="siterep_public_key" type="text" class="regular-text" value="<?php echo esc_attr( $public_key ); ?>" autocomplete="off" />
						<p class="description"><?php esc_html_e( 'Your widget key is locked to your domain by Site Rep, so it is safe to use here.', 'siterep' ); ?></p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="siterep_theme"><?php esc_html_e( 'Accent colour (optional)', 'siterep' ); ?></label></th>
					<td><input name="<?php echo esc_attr( SITEREP_OPTION ); ?>[theme]" id="siterep_theme" type="text" class="regular-text" placeholder="#1f8f5f" value="<?php echo esc_attr( $theme ); ?>" /></td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

/**
 * Inject the widget script into the site footer. Uses data- attributes on the
 * script tag — the form Site Rep recommends because CMS page builders often
 * strip or reorder inline config blocks, but attributes survive.
 */
function siterep_enqueue_widget() {
	if ( is_admin() ) {
		return;
	}
	$settings   = get_option( SITEREP_OPTION, array() );
	$bot_id     = isset( $settings['bot_id'] ) ? $settings['bot_id'] : '';
	$public_key = isset( $settings['public_key'] ) ? $settings['public_key'] : '';
	if ( '' === $bot_id || '' === $public_key ) {
		return;
	}
	$theme = isset( $settings['theme'] ) ? $settings['theme'] : '';

	$attrs = sprintf(
		' src="%s" data-bot-id="%s" data-public-key="%s" data-api-base="%s"',
		esc_url( SITEREP_WIDGET_SRC ),
		esc_attr( $bot_id ),
		esc_attr( $public_key ),
		esc_url( SITEREP_API_BASE )
	);
	if ( '' !== $theme ) {
		$attrs .= sprintf( ' data-theme="%s"', esc_attr( $theme ) );
	}
	echo '<script' . $attrs . ' defer></script>' . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- each attribute is individually escaped above.
}
add_action( 'wp_footer', 'siterep_enqueue_widget' );

/**
 * Add a Settings shortcut from the Plugins list.
 */
function siterep_action_links( $links ) {
	$settings_link = '<a href="' . esc_url( admin_url( 'options-general.php?page=siterep' ) ) . '">' . esc_html__( 'Settings', 'siterep' ) . '</a>';
	array_unshift( $links, $settings_link );
	return $links;
}
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'siterep_action_links' );
