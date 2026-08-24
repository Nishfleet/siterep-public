# Site Rep WordPress plugin

A small WordPress plugin that injects the Site Rep widget into a site's footer
from a Workspace ID + widget key entered in **Settings → Site Rep**. No code,
no secrets stored (the widget key is domain-locked server-side and safe to
expose in markup).

## Layout

```
wordpress-plugin/
  siterep/
    siterep.php    # plugin (settings page + wp_footer injection)
    readme.txt     # WordPress.org listing (their required format)
```

## What it injects

The CMS-resilient form recommended by the dashboard — a single script tag with
`data-` attributes (inline `window.siterep` config blocks get stripped or
reordered by page builders; attributes survive):

```html
<script src="https://siterep.net/widget.js"
        data-bot-id="WORKSPACE_ID"
        data-public-key="WIDGET_KEY"
        data-api-base="https://siterep.net"
        data-theme="#1f8f5f" defer></script>
```

`widget.js` reads `data-bot-id` / `data-public-key` / `data-api-base` /
`data-theme` off its own `document.currentScript` (see `public/widget.js`), so
this matches the supported config contract exactly.

## Security

- Settings save through the WordPress Settings API (`settings_fields` provides
  the nonce); the settings page checks `manage_options`.
- Inputs are sanitised on save (bot id / key to `[A-Za-z0-9_-]`, theme to a
  6-digit hex colour) and every injected attribute is escaped (`esc_attr` /
  `esc_url`) on output.
- No passwords or tokens are stored — only the public, domain-locked widget key.

## Packaging

```sh
cd wordpress-plugin
zip -r siterep.zip siterep -x '*.DS_Store'
```

`siterep.zip` installs via **Plugins → Add New → Upload Plugin**.

## Publishing to the WordPress.org directory

Listing on wordpress.org/plugins requires WordPress.org's external review:

1. Submit `siterep` for review at https://wordpress.org/plugins/developers/add/
   (one-time manual review by the plugins team).
2. On approval, WordPress provisions an SVN repo; push the `siterep/` contents
   to `trunk/` and tag `1.0.0/`.
3. Add `assets/` (icon, banner, screenshots) in the SVN repo root.

Until approval, the zip can be shared directly with customers and linked from
the dashboard install instructions.
